import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ClineMessage, RooCodeEventName } from "@roo-code/types";
import { isEqual } from "es-toolkit";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";

import { ExtensionController } from "../../core/controller";
import { logger } from "../../utils/logger";
import {
  addAgentMaestroMcpConfig,
  getAvailableExtensions,
} from "../../utils/mcpConfig";
import {
  ImagesDataUriSchema,
  imagesDataUriErrorMessage,
} from "../schemas/cline";
import { ErrorResponseSchema } from "../schemas/common";
import {
  CreateProfileRequestSchema,
  HistoryItemSchema,
  ProfileResponseSchema,
  ProviderSettingsEntrySchema,
  RooActionRequestSchema,
  RooMessageRequestSchema,
  RooTaskResponseSchema,
  SetActiveProfileRequestSchema,
  UpdateProfileRequestSchema,
} from "../schemas/roo";
import { TaskEvent } from "../types";

const filteredSayTypes = ["api_req_started"];

// Helper function to process event stream with deduplication
const processEventStream = async (
  eventStream: AsyncGenerator<TaskEvent, void, unknown>,
  stream: any, // Hono SSE stream
): Promise<void> => {
  // Helper function to send SSE data
  const sendSSE = (event: TaskEvent) => {
    stream.writeSSE({
      event: event.name,
      data: JSON.stringify(event.data),
    });
  };

  let lastMessage: ClineMessage | undefined;

  // Process events from async generator
  for await (const event of eventStream) {
    switch (event.name) {
      case RooCodeEventName.Message: {
        const { message } = (event as TaskEvent<RooCodeEventName.Message>).data;
        if (filteredSayTypes.includes(message.say ?? "")) {
          continue; // Skip filtered messages
        }
        if (
          !message.partial &&
          lastMessage &&
          !lastMessage.partial &&
          isEqual(lastMessage, message)
        ) {
          // Skip sending duplicate complete messages
          continue;
        }
        if (!message.partial) {
          lastMessage = message;
        }
      }

      default:
        sendSSE(event);
    }
  }
};

// OpenAPI route definitions
const createRooTaskRoute = createRoute({
  method: "post",
  path: "/roo/task",
  tags: ["Tasks"],
  summary: "Create a new RooCode task",
  description:
    "Creates and starts a new task using the RooCode extension. Returns Server-Sent Events stream for task progress.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: RooMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Server-Sent Events stream for task progress",
      content: {
        "text/event-stream": {
          schema: z.string(),
        },
      },
      headers: z.object({
        "Content-Type": z.string().openapi({ example: "text/event-stream" }),
        "Cache-Control": z.string().openapi({ example: "no-cache" }),
        Connection: z.string().openapi({ example: "keep-alive" }),
      }),
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// Create the message route schema
const sendMessageRoute = createRoute({
  method: "post",
  path: "/roo/task/{taskId}/message",
  tags: ["Tasks"],
  summary: "Send message to existing RooCode task",
  description:
    "Sends a message to an existing RooCode task. Returns Server-Sent Events stream for task progress.",
  request: {
    params: z.object({
      taskId: z.string().describe("The task ID to send the message to"),
    }),
    body: {
      content: {
        "application/json": {
          schema: RooMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Server-Sent Events stream for task progress",
      content: {
        "text/event-stream": {
          schema: z.string(),
        },
      },
      headers: z.object({
        "Content-Type": z.string().openapi({ example: "text/event-stream" }),
        "Cache-Control": z.string().openapi({ example: "no-cache" }),
        Connection: z.string().openapi({ example: "keep-alive" }),
      }),
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Task not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// Create the task action route schema
const taskActionRoute = createRoute({
  method: "post",
  path: "/roo/task/{taskId}/action",
  tags: ["Tasks"],
  summary: "Perform actions on a RooCode task",
  description:
    "Perform specific actions on an existing RooCode task, such as pressing buttons for approvals",
  request: {
    params: z.object({
      taskId: z.string().describe("The task ID to perform the action on"),
    }),
    body: {
      content: {
        "application/json": {
          schema: RooActionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: RooTaskResponseSchema,
        },
      },
      description: "Action performed successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - invalid input or action not allowed",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Task not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

const getTaskHistoryRoute = createRoute({
  method: "get",
  path: "/roo/tasks",
  tags: ["Tasks"],
  summary: "Get RooCode task history",
  description:
    "Retrieves the complete task history from RooCode extension configuration",
  request: {
    query: z.object({
      extensionId: z
        .string()
        .optional()
        .describe(
          "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z
              .array(HistoryItemSchema)
              .describe("Array of task history items"),
          }),
        },
      },
      description: "Task history retrieved successfully",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

const getTaskByIdRoute = createRoute({
  method: "get",
  path: "/roo/task/{taskId}",
  tags: ["Tasks"],
  summary: "Get RooCode task by ID",
  request: {
    params: z.object({
      taskId: z.string().describe("The task ID to retrieve"),
    }),
    query: z.object({
      extensionId: z
        .string()
        .optional()
        .describe(
          "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
        ),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            historyItem: HistoryItemSchema.describe("Task history item data"),
            taskDirPath: z.string().describe("Path to the task directory"),
            apiConversationHistoryFilePath: z
              .string()
              .describe("Path to the API conversation history file"),
            uiMessagesFilePath: z
              .string()
              .describe("Path to the UI messages file"),
            apiConversationHistory: z
              .array(z.any())
              .describe("Array of Anthropic MessageParam objects"),
          }),
        },
      },
      description: "Task details with history and conversation data",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Task not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// Create the MCP config route schema
const installMcpConfigRoute = createRoute({
  method: "post",
  path: "/roo/install-mcp-config",
  tags: ["MCP Configuration"],
  summary: "Add Agent Maestro MCP configuration",
  description:
    "Adds Agent Maestro MCP server configuration to the specified extension's settings",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            extensionId: z
              .string()
              .optional()
              .describe(
                "The extension ID to add configuration to. If not provided, uses the first available installed extension that supports MCP configuration.",
              ),
          }),
        },
      },
      required: false,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            extensionId: z
              .string()
              .describe("The extension ID that was configured"),
            extensionDisplayName: z
              .string()
              .describe("The display name of the configured extension"),
            success: z
              .boolean()
              .describe("Whether the operation was successful"),
            message: z.string().describe("Success message"),
          }),
        },
      },
      description: "Configuration added successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description:
        "Bad request - invalid extension ID, no supported extensions installed, or configuration already exists",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// Profile Management Routes

// GET /roo/profiles - List all profiles or get active profile
const listProfilesRoute = createRoute({
  method: "get",
  path: "/roo/profiles",
  tags: ["Configuration"],
  summary: "List configuration profiles",
  description:
    "Retrieves all configuration profiles with active profile information",
  request: {
    query: z.object({
      extensionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            profiles: z.array(ProviderSettingsEntrySchema),
            activeProfile: ProviderSettingsEntrySchema.optional(),
          }),
        },
      },
      description: "Profiles retrieved successfully",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// GET /roo/profiles/:name - Get specific profile
const getProfileRoute = createRoute({
  method: "get",
  path: "/roo/profiles/{name}",
  tags: ["Configuration"],
  summary: "Get a specific configuration profile",
  description: "Retrieves detailed information about a specific profile",
  request: {
    params: z.object({
      name: z.string().describe("Profile name"),
    }),
    query: z.object({
      extensionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ProfileResponseSchema,
        },
      },
      description: "Profile retrieved successfully",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Profile not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// POST /roo/profiles - Create new profile
const createProfileRoute = createRoute({
  method: "post",
  path: "/roo/profiles",
  tags: ["Configuration"],
  summary: "Create a new configuration profile",
  description: "Creates a new configuration profile with the provided settings",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            message: z.string(),
            activated: z.boolean(),
          }),
        },
      },
      description: "Profile created successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - profile already exists",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// PUT /roo/profiles/:name - Update profile
const updateProfileRoute = createRoute({
  method: "put",
  path: "/roo/profiles/{name}",
  tags: ["Configuration"],
  summary: "Update an existing configuration profile",
  description: "Updates an existing profile with new settings",
  request: {
    params: z.object({
      name: z.string().describe("Profile name"),
    }),
    body: {
      content: {
        "application/json": {
          schema: UpdateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            name: z.string(),
            message: z.string(),
            activated: z.boolean(),
          }),
        },
      },
      description: "Profile updated successfully",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Profile not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

//DELETE /roo/profiles/:name - Delete profile
const deleteProfileRoute = createRoute({
  method: "delete",
  path: "/roo/profiles/{name}",
  tags: ["Configuration"],
  summary: "Delete a configuration profile",
  description: "Deletes an existing configuration profile",
  request: {
    params: z.object({
      name: z.string().describe("Profile name"),
    }),
    query: z.object({
      extensionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            message: z.string(),
          }),
        },
      },
      description: "Profile deleted successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - cannot delete active profile",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Profile not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// PUT /roo/profiles/active/:name - Set active profile
const setActiveProfileRoute = createRoute({
  method: "put",
  path: "/roo/profiles/active/{name}",
  tags: ["Configuration"],
  summary: "Set a profile as active",
  description: "Activates the specified configuration profile",
  request: {
    params: z.object({
      name: z.string().describe("Profile name to activate"),
    }),
    body: {
      content: {
        "application/json": {
          schema: SetActiveProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string(),
            message: z.string(),
          }),
        },
      },
      description: "Profile activated successfully",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Profile not found",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// GET /roo/modes - Get available modes including custom modes
const getModesRoute = createRoute({
  method: "get",
  path: "/roo/modes",
  tags: ["Configuration"],
  summary: "Get available modes",
  description:
    "Retrieves all available modes including custom modes from RooCode configuration",
  request: {
    query: z.object({
      extensionId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            modes: z.array(
              z.object({
                slug: z.string(),
                name: z.string(),
                roleDefinition: z.string().optional(),
                customInstructions: z.string().optional(),
                groups: z.array(z.any()).optional(),
                source: z.enum(["builtin", "custom"]),
              }),
            ),
          }),
        },
      },
      description: "Modes retrieved successfully",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

export function registerRooRoutes(
  app: OpenAPIHono,
  controller: ExtensionController,
  context: vscode.ExtensionContext,
) {
  // POST /api/v1/roo/task - Create new RooCode task with SSE stream
  app.openapi(createRooTaskRoute, async (c) => {
    try {
      const { text, images, configuration, newTab, extensionId } =
        await c.req.json();

      const parsedImages = ImagesDataUriSchema.safeParse(images);
      if (!parsedImages.success) {
        return c.json({ message: imagesDataUriErrorMessage }, 400);
      }

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      return streamSSE(c, async (stream) => {
        try {
          // Create new task using async generator
          logger.info("Creating new RooCode task with async generator");

          const eventStream = adapter.startNewTask({
            text,
            images,
            configuration,
            newTab,
          });

          await processEventStream(eventStream, stream);
          logger.info(`Completed RooCode task stream`);
        } catch (error) {
          logger.error("Error processing RooCode task:", error);
          stream.writeSSE({
            event: RooCodeEventName.TaskAborted,
            data: JSON.stringify({
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown error occurred",
            }),
          });
        } finally {
          stream.close();
        }
      });
    } catch (error) {
      logger.error("Error processing RooCode task request:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // POST /api/v1/roo/task/:taskId/message - Send message to existing RooCode task
  app.openapi(sendMessageRoute, async (c) => {
    try {
      const { taskId } = c.req.param();
      const { text, images, extensionId } = await c.req.json();

      const parsedImages = ImagesDataUriSchema.safeParse(images);
      if (!parsedImages.success) {
        return c.json({ message: imagesDataUriErrorMessage }, 400);
      }

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      // Check if task exists in active tasks or history
      const activeTaskIds = adapter.getActiveTaskIds();
      const isTaskInHistory = await adapter.isTaskInHistory(taskId);

      if (!activeTaskIds.includes(taskId) && !isTaskInHistory) {
        return c.json({ message: `Task with ID ${taskId} not found` }, 404);
      }

      // If task is in history, resume it first
      if (!activeTaskIds.includes(taskId) && isTaskInHistory) {
        await adapter.resumeTask(taskId);
      }

      return streamSSE(c, async (stream) => {
        try {
          // Send message to existing task using async generator
          logger.info(`Sending message to existing task: ${taskId}`);

          // Send the message and process events from async generator
          const eventStream = adapter.sendMessage(text, images, {
            taskId,
          });

          await processEventStream(eventStream, stream);
          logger.info(`Completed message processing for task: ${taskId}`);
        } catch (error) {
          logger.error("Error processing RooCode task:", error);
          stream.writeSSE({
            event: RooCodeEventName.TaskAborted,
            data: JSON.stringify({
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown error occurred",
            }),
          });
        } finally {
          stream.close();
        }
      });
    } catch (error) {
      logger.error("Error processing RooCode task message request:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // POST /api/v1/roo/task/:taskId/action - Handle task actions
  app.openapi(taskActionRoute, async (c) => {
    try {
      const { taskId } = c.req.param();
      const { action, extensionId } = await c.req.json();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      // Check if task exists in active tasks or history
      const activeTaskIds = adapter.getActiveTaskIds();
      const isTaskInHistory = await adapter.isTaskInHistory(taskId);

      if (!activeTaskIds.includes(taskId) && !isTaskInHistory) {
        return c.json({ message: `Task with ID ${taskId} not found` }, 404);
      }

      // If task is in history, resume it first
      if (!activeTaskIds.includes(taskId) && isTaskInHistory) {
        await adapter.resumeTask(taskId);
      }

      switch (action) {
        case "pressPrimaryButton":
          await adapter.pressPrimaryButton();
          logger.info(`Primary button pressed for task ${taskId}`);
          return c.json({
            id: taskId,
            status: "completed" as const,
            message: "Primary button pressed successfully",
          });

        case "pressSecondaryButton":
          await adapter.pressSecondaryButton();
          logger.info(`Secondary button pressed for task ${taskId}`);
          return c.json({
            id: taskId,
            status: "completed" as const,
            message: "Secondary button pressed successfully",
          });

        case "cancel":
          // Check if the taskId is in the current active tasks
          if (activeTaskIds.includes(taskId)) {
            await adapter.cancelCurrentTask();
            logger.info(`Task cancelled: ${taskId}`);
            return c.json({
              id: taskId,
              status: "completed" as const,
              message: "Task cancelled successfully",
            });
          } else {
            return c.json(
              { message: "Only current active tasks can be cancelled" },
              400,
            );
          }

        case "resume":
          await adapter.resumeTask(taskId);
          logger.info(`Task resumed: ${taskId}`);
          return c.json({
            id: taskId,
            status: "running" as const,
            message: "Task resumed successfully",
          });

        default:
          return c.json({ message: `Unknown action: ${action}` }, 400);
      }
    } catch (error) {
      logger.error("Error handling task action:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // GET /api/v1/roo/tasks - Get RooCode task history
  app.openapi(getTaskHistoryRoute, async (c) => {
    try {
      const { extensionId } = c.req.query();

      // Get the appropriate adapter
      const adapter = controller.getRooAdapter(extensionId);

      if (!adapter) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      return c.json(
        {
          data: adapter.getTaskHistory(),
        },
        200,
      );
    } catch (error) {
      logger.error("Error retrieving task history:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // GET /api/v1/roo/task/:taskId - Get RooCode task by ID
  app.openapi(getTaskByIdRoute, async (c) => {
    try {
      const { taskId } = c.req.param();
      const { extensionId } = c.req.query();

      // Get the appropriate adapter
      const adapter = controller.getRooAdapter(extensionId);

      if (!adapter) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      const taskData = await adapter.getTaskWithId(taskId);

      return c.json(taskData, 200);
    } catch (error) {
      logger.error(`Error getting task ${c.req.param("taskId")}:`, error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // POST /api/v1/roo/install-mcp-config - Auto install Agent Maestro MCP config to the extension
  app.openapi(installMcpConfigRoute, async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { extensionId } = body;

      // Get available extensions (now returns ExtensionInfo[] with id and displayName)
      const availableExtensions = getAvailableExtensions();

      // Handle case where no supported extensions are installed
      if (availableExtensions.length === 0) {
        return c.json(
          {
            message:
              "No supported extensions are currently installed. Please install a compatible extension like Roo Code or Kilo Code.",
          },
          400,
        );
      }

      // Use default extension ID if not provided - use the first available extension
      const targetExtensionId = extensionId || availableExtensions[0].id;

      // Validate that the target extension is in the available extensions
      const targetExtension = availableExtensions.find(
        (ext) => ext.id === targetExtensionId,
      );
      if (!targetExtension) {
        const extensionNames = availableExtensions.map(
          (ext) => `${ext.displayName} (${ext.id})`,
        );
        return c.json(
          {
            message: `Unsupported extension ID: ${targetExtensionId}. Available extensions: ${extensionNames.join(", ")}`,
          },
          400,
        );
      }

      const result = await addAgentMaestroMcpConfig({
        extensionId: targetExtensionId,
        globalStorageUri: context.globalStorageUri,
      });

      if (!result.success) {
        return c.json({ message: result.message }, 400);
      }

      logger.info(
        `Added Agent Maestro MCP configuration for ${targetExtensionId}`,
      );

      return c.json(
        {
          extensionId: targetExtensionId,
          extensionDisplayName: targetExtension.displayName,
          success: true,
          message: result.message,
        },
        200,
      );
    } catch (error) {
      logger.error("Error adding MCP configuration:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // GET /api/v1/roo/profiles - List all profiles or get active profile
  app.openapi(listProfilesRoute, async (c) => {
    try {
      const { extensionId } = c.req.query();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      const activeProfileName = adapter.getActiveProfile();
      const profileNames = adapter.getProfiles();

      // Get full profile details for each profile
      const profiles = profileNames.map((name) => {
        const profileEntry = adapter.getProfileEntry(name);
        if (!profileEntry) {
          return {
            id: name, // Use name as ID since getProfiles returns names
            name: name,
            apiProvider: undefined,
          };
        }
        return {
          id: profileEntry.id,
          name: name,
          apiProvider: profileEntry.apiProvider,
        };
      });

      // Find the active profile object
      const activeProfile = activeProfileName
        ? profiles.find((profile) => profile.name === activeProfileName)
        : undefined;

      return c.json(
        {
          profiles,
          activeProfile,
        },
        200,
      );
    } catch (error) {
      logger.error("Error listing profiles:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // GET /api/v1/roo/profiles/:name - Get specific profile
  app.openapi(getProfileRoute, async (c) => {
    try {
      const { name } = c.req.param();
      const { extensionId } = c.req.query();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      const profileEntry = adapter.getProfileEntry(name);
      if (!profileEntry) {
        return c.json({ message: `Profile '${name}' not found` }, 404);
      }

      const activeProfileName = adapter.getActiveProfile();

      // Get the full configuration to extract provider settings
      const config = adapter.api?.getConfiguration();
      if (!config) {
        return c.json({ message: "Unable to retrieve configuration" }, 500);
      }

      // Extract provider settings from the configuration
      const providerSettings: any = {};

      // Copy relevant provider settings based on the profile's apiProvider
      if (profileEntry.apiProvider) {
        providerSettings.apiProvider = profileEntry.apiProvider;

        // Copy all provider-specific settings from config
        Object.keys(config).forEach((key) => {
          if (
            key.startsWith("model") ||
            key.includes("ApiKey") ||
            key.includes("BaseUrl") ||
            key === "includeMaxTokens" ||
            key === "reasoningEffort" ||
            key === "diffEnabled" ||
            key === "fuzzyMatchThreshold" ||
            key === "rateLimitSeconds"
          ) {
            providerSettings[key] = config[key as keyof typeof config];
          }
        });
      }

      return c.json(
        {
          id: profileEntry.id,
          name: name,
          profile: providerSettings,
          isActive: name === activeProfileName,
        },
        200,
      );
    } catch (error) {
      logger.error(`Error getting profile ${c.req.param("name")}:`, error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // POST /api/v1/roo/profiles - Create new profile
  app.openapi(createProfileRoute, async (c) => {
    try {
      const { name, profile, activate, extensionId } = await c.req.json();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      // Check if profile already exists
      const existingProfiles = adapter.getProfiles();
      if (existingProfiles.includes(name)) {
        return c.json({ message: `Profile '${name}' already exists` }, 400);
      }

      // Create the profile
      const profileId = await adapter.createProfile(name, profile, activate);

      logger.info(`Created profile '${name}' with ID: ${profileId}`);

      return c.json(
        {
          id: profileId,
          name,
          message: `Profile '${name}' created successfully`,
          activated: activate || false,
        },
        201,
      );
    } catch (error) {
      logger.error("Error creating profile:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // PUT /api/v1/roo/profiles/:name - Update profile
  app.openapi(updateProfileRoute, async (c) => {
    try {
      const { name } = c.req.param();
      const { profile, activate, extensionId } = await c.req.json();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      // Check if profile exists
      const profileEntry = adapter.getProfileEntry(name);
      if (!profileEntry) {
        return c.json({ message: `Profile '${name}' not found` }, 404);
      }

      // Update the profile
      const updatedId = await adapter.updateProfile(name, profile, activate);

      logger.info(`Updated profile '${name}'`);

      return c.json(
        {
          id: updatedId || profileEntry.id,
          name,
          message: `Profile '${name}' updated successfully`,
          activated: activate || false,
        },
        200,
      );
    } catch (error) {
      logger.error(`Error updating profile ${c.req.param("name")}:`, error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // DELETE /api/v1/roo/profiles/:name - Delete profile
  app.openapi(deleteProfileRoute, async (c) => {
    try {
      const { name } = c.req.param();
      const { extensionId } = c.req.query();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      // Check if profile exists
      const profileNames = adapter.getProfiles();
      if (!profileNames.includes(name)) {
        return c.json({ message: `Profile '${name}' not found` }, 404);
      }

      // Check if it's the active profile
      const activeProfileName = adapter.getActiveProfile();
      if (name === activeProfileName) {
        return c.json({ message: "Cannot delete the active profile" }, 400);
      }

      // Delete the profile
      await adapter.deleteProfile(name);

      logger.info(`Deleted profile '${name}'`);

      return c.json(
        {
          message: `Profile '${name}' deleted successfully`,
        },
        200,
      );
    } catch (error) {
      logger.error(`Error deleting profile ${c.req.param("name")}:`, error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // PUT /api/v1/roo/profiles/active/:name - Set active profile
  app.openapi(setActiveProfileRoute, async (c) => {
    try {
      const { name } = c.req.param();
      const { extensionId } = await c.req.json();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      // Check if profile exists
      const profileNames = adapter.getProfiles();
      if (!profileNames.includes(name)) {
        return c.json({ message: `Profile '${name}' not found` }, 404);
      }

      // Set as active
      await adapter.setActiveProfile(name);

      logger.info(`Set profile '${name}' as active`);

      return c.json(
        {
          name,
          message: `Profile '${name}' is now active`,
        },
        200,
      );
    } catch (error) {
      logger.error(
        `Error setting active profile ${c.req.param("name")}:`,
        error,
      );
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // GET /api/v1/roo/modes - Get available modes including custom modes
  app.openapi(getModesRoute, async (c) => {
    try {
      const { extensionId } = c.req.query();

      const adapter = controller.getRooAdapter(extensionId);
      if (!adapter?.isActive) {
        return c.json(
          { message: `RooCode extension ${extensionId} is not available` },
          500,
        );
      }

      const config = adapter.getConfiguration();

      // Default built-in modes
      const builtinModes = [
        { slug: "code", name: "Code", source: "builtin" as const },
        { slug: "architect", name: "Architect", source: "builtin" as const },
        { slug: "ask", name: "Ask", source: "builtin" as const },
        { slug: "debug", name: "Debug", source: "builtin" as const },
        {
          slug: "orchestrator",
          name: "Orchestrator",
          source: "builtin" as const,
        },
      ];

      // Get custom modes from configuration if available
      const customModes: Array<{
        slug: string;
        name: string;
        roleDefinition?: string;
        customInstructions?: string;
        groups?: any[];
        source: "custom";
      }> = [];

      // Check if config has customModes property (from RooCodeSettings)
      if (config && typeof config === "object" && "customModes" in config) {
        const configCustomModes = (config as any).customModes;
        if (Array.isArray(configCustomModes)) {
          for (const mode of configCustomModes) {
            customModes.push({
              slug: mode.slug || mode.name?.toLowerCase().replace(/\s+/g, "-"),
              name: mode.name || mode.slug,
              roleDefinition: mode.roleDefinition,
              customInstructions: mode.customInstructions,
              groups: mode.groups,
              source: "custom" as const,
            });
          }
        }
      }

      // Combine built-in and custom modes
      const allModes = [...builtinModes, ...customModes];

      logger.info(
        `Retrieved ${allModes.length} modes (${builtinModes.length} builtin, ${customModes.length} custom)`,
      );

      return c.json({ modes: allModes }, 200);
    } catch (error) {
      logger.error("Error retrieving modes:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });
}
