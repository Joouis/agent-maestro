import { ClineMessage, RooCodeEventName } from "@roo-code/types";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { TaskEvent } from "../types";
import {
  addAgentMaestroMcpConfig,
  getAvailableExtensions,
} from "../../utils/mcpConfig";
import {
  ErrorResponseSchema,
  ImagesDataUriSchema,
  imagesDataUriErrorMessage,
  RooMessageRequestSchema,
  RooActionRequestSchema,
  HistoryItemSchema,
  RooTaskResponseSchema,
} from "../schemas";
import { isEqual } from "es-toolkit";

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

export function registerRooRoutes(
  app: OpenAPIHono,
  controller: ExtensionController,
  context?: vscode.ExtensionContext,
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
        return c.json({ message: "RooCode extension is not available" }, 500);
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
        return c.json({ message: "RooCode extension is not available" }, 500);
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
        return c.json({ message: "RooCode extension is not available" }, 500);
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
        return c.json({ message: "RooCode extension is not available" }, 500);
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
        return c.json({ message: "RooCode extension is not available" }, 500);
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
      if (!context) {
        return c.json({ message: "Extension context not available" }, 500);
      }

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
}
