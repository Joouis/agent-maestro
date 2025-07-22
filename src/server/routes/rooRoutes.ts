import { ClineMessage } from "@roo-code/types";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { MessageRequest, ActionRequest } from "../types";
import {
  isMessageCompleted,
  areCompletedMessagesEqual,
} from "../utils/rooUtils";
import {
  addAgentMaestroMcpConfig,
  getAvailableExtensions,
} from "../../utils/mcpConfig";

export enum SSEEventType {
  STREAM_CLOSED = "stream_closed",
  MESSAGE = "message",
  TASK_COMPLETED = "task_completed",
  TASK_ABORTED = "task_aborted",
  TOOL_FAILED = "tool_failed",
  TASK_CREATED = "task_created",
  ERROR = "error",
  TASK_RESUMED = "task_resumed",
}

const filteredSayTypes = ["api_req_started"];
const CLOSE_SSE_STREAM_DELAY_MS = 1_000;

// Helper function to set up SSE headers and return sendSSE function
function setupSSEResponse(
  reply: FastifyReply,
  request: FastifyRequest,
  onDisconnect?: () => void,
) {
  // Set up SSE headers
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");
  reply.raw.setHeader("Access-Control-Allow-Headers", "Cache-Control");

  // Helper function to send SSE data
  const sendSSE = (eventType: string, data: any) => {
    const sseData = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    reply.raw.write(sseData);
  };

  // Handle client disconnect
  request.raw.on("close", () => {
    logger.info("Client disconnected from SSE stream");
    onDisconnect?.();
  });

  request.raw.on("error", (err: Error) => {
    logger.error("SSE stream error:", err);
    onDisconnect?.();
  });

  // Helper function to close SSE stream with event notification
  const closeSSEStream = (message: string) => {
    sendSSE(SSEEventType.STREAM_CLOSED, { message });

    setTimeout(() => {
      reply.raw.end();
      onDisconnect?.();
    }, CLOSE_SSE_STREAM_DELAY_MS);
  };

  return { sendSSE, closeSSEStream };
}

// Helper function to create event handlers for task streaming
function createTaskEventHandlers(
  sendSSE: (eventType: string, data: any) => void,
  closeSSEStream: (message: string) => void,
) {
  let lastMessage: ClineMessage | undefined;

  return {
    onMessage: (handlerTaskId: string, message: ClineMessage) => {
      if (filteredSayTypes.includes(message.say ?? "")) {
        return;
      }

      if (areCompletedMessagesEqual(message, lastMessage)) {
        // Skip duplicate message
        return;
      }

      // Store current message for next comparison
      if (isMessageCompleted(message)) {
        lastMessage = message;
      }

      sendSSE(SSEEventType.MESSAGE, {
        taskId: handlerTaskId,
        message,
      });

      // Close SSE stream when followup question is asked
      if (isMessageCompleted(message) && message.ask === "followup") {
        closeSSEStream("followup_question");
      }
    },
    onTaskCompleted: (
      handlerTaskId: string,
      tokenUsage: any,
      toolUsage: any,
    ) => {
      logger.info(`Task completed: ${handlerTaskId}`, {
        tokenUsage,
        toolUsage,
      });
      sendSSE(SSEEventType.TASK_COMPLETED, {
        taskId: handlerTaskId,
        tokenUsage,
        toolUsage,
      });

      closeSSEStream("task_completed");
    },
    onTaskAborted: (handlerTaskId: string) => {
      logger.warn(`Task aborted: ${handlerTaskId}`);
      sendSSE(SSEEventType.TASK_ABORTED, {
        taskId: handlerTaskId,
      });

      closeSSEStream("task_aborted");
    },
    onTaskToolFailed: (handlerTaskId: string, tool: string, error: string) => {
      logger.error(`Tool failed in task ${handlerTaskId}: ${tool} - ${error}`);
      sendSSE(SSEEventType.TOOL_FAILED, {
        taskId: handlerTaskId,
        tool,
        error,
      });
    },
  };
}

export async function registerRooRoutes(
  fastify: FastifyInstance,
  controller: ExtensionController,
  context?: vscode.ExtensionContext,
) {
  // Add the shared schema to fastify
  fastify.addSchema({
    $id: "HistoryItem",
    type: "object",
    properties: {
      id: { type: "string" },
      number: { type: "number" },
      ts: { type: "number" },
      task: { type: "string" },
      tokensIn: { type: "number" },
      tokensOut: { type: "number" },
      cacheWrites: { type: "number" },
      cacheReads: { type: "number" },
      totalCost: { type: "number" },
      size: { type: "number" },
      workspace: { type: "string" },
    },
    required: [
      "id",
      // "number", // Could be undefined in real cases
      "ts",
      "task",
      "tokensIn",
      "tokensOut",
      "totalCost",
    ],
  });

  // POST /api/v1/roo/task - Create new RooCode task with SSE stream
  fastify.post(
    "/roo/task",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Create a new RooCode task",
        description:
          "Creates and starts a new task using the RooCode extension. Returns Server-Sent Events stream for task progress.",
        body: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The task query text",
            },
            images: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional array of image URLs or base64 encoded images",
            },
            configuration: {
              type: "object",
              description: "RooCode configuration settings",
            },
            newTab: {
              type: "boolean",
              description:
                "Whether to open the task in a new tab. Note: When enabled, users cannot send follow-up messages due to issue https://github.com/RooCodeInc/Roo-Code/issues/4412",
            },
            extensionId: {
              type: "string",
              description:
                "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
            },
          },
          required: ["text"],
        },
        response: {
          200: {
            description: "Server-Sent Events stream for task progress",
            type: "string",
            headers: {
              "Content-Type": {
                type: "string",
                example: "text/event-stream",
              },
              "Cache-Control": { type: "string", example: "no-cache" },
              Connection: { type: "string", example: "keep-alive" },
            },
          },
          400: {
            description: "Bad request - invalid input",
            $ref: "ErrorResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { text, images, configuration, newTab, extensionId } =
          request.body as MessageRequest;

        if (!text || text.trim() === "") {
          return reply.status(400).send({
            message: "Task query is required",
          });
        }

        const adapter = controller.getRooAdapter(extensionId);
        if (!adapter?.isActive) {
          return reply.status(500).send({
            message: "RooCode extension is not available",
          });
        }

        let currentTaskId: string | undefined;
        const onDisconnect = () => {
          if (currentTaskId) {
            adapter.removeTaskHandlers(currentTaskId);
          }
        };

        // Use shared SSE setup
        const { sendSSE, closeSSEStream } = setupSSEResponse(
          reply,
          request,
          onDisconnect,
        );
        const eventHandlers = createTaskEventHandlers(sendSSE, closeSSEStream);

        try {
          // Create new task logic
          logger.info("Creating new RooCode task");

          const newTaskId = await adapter.startNewTask({
            text,
            images,
            configuration,
            newTab,
            eventHandlers,
          });

          // Store the task ID for cleanup on disconnect
          currentTaskId = newTaskId;

          // Send initial task created event
          sendSSE(SSEEventType.TASK_CREATED, {
            taskId: newTaskId || uuidv4(),
            status: "created",
            message: "Task created successfully",
          });

          logger.info(`Created new RooCode task with SSE: ${newTaskId}`);
        } catch (taskError) {
          logger.error("Error processing RooCode task:", taskError);
          sendSSE(SSEEventType.ERROR, {
            error:
              taskError instanceof Error
                ? taskError.message
                : "Unknown error occurred",
          });
          reply.raw.end();
        }
      } catch (error) {
        logger.error("Error processing RooCode task request:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  // POST /api/v1/roo/task/:taskId/message - Send message to existing RooCode task
  fastify.post(
    "/roo/task/:taskId/message",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Send message to existing RooCode task",
        description:
          "Sends a message to an existing RooCode task. Returns Server-Sent Events stream for task progress.",
        params: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The task ID to send the message to",
            },
          },
          required: ["taskId"],
        },
        body: { $ref: "MessageRequest#" },
        response: {
          200: {
            description: "Server-Sent Events stream for task progress",
            type: "string",
            headers: {
              "Content-Type": {
                type: "string",
                example: "text/event-stream",
              },
              "Cache-Control": { type: "string", example: "no-cache" },
              Connection: { type: "string", example: "keep-alive" },
            },
          },
          400: {
            description: "Bad request - invalid input",
            $ref: "ErrorResponse#",
          },
          404: {
            description: "Task not found",
            $ref: "ErrorResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { taskId } = request.params as {
          taskId: string;
        };
        const { text, images, extensionId } = request.body as MessageRequest;

        if (!text || text.trim() === "") {
          return reply.status(400).send({
            message: "Message text is required",
          });
        }

        const adapter = controller.getRooAdapter(extensionId);
        if (!adapter?.isActive) {
          return reply.status(500).send({
            message: "RooCode extension is not available",
          });
        }

        // Check if task exists in active tasks or history
        const activeTaskIds = adapter.getActiveTaskIds();
        const isTaskInHistory = await adapter.isTaskInHistory(taskId);

        if (!activeTaskIds.includes(taskId) && !isTaskInHistory) {
          return reply.status(404).send({
            message: `Task with ID ${taskId} not found`,
          });
        }

        const onDisconnect = () => {
          adapter.removeTaskHandlers(taskId);
        };

        // Use shared SSE setup
        const { sendSSE, closeSSEStream } = setupSSEResponse(
          reply,
          request,
          onDisconnect,
        );
        const eventHandlers = createTaskEventHandlers(sendSSE, closeSSEStream);

        try {
          // Send message to existing task logic
          logger.info(`Sending message to existing task: ${taskId}`);

          // If task is in history, resume it first
          if (!activeTaskIds.includes(taskId) && isTaskInHistory) {
            await adapter.resumeTask(taskId);
          }

          // Send initial task resumed event
          sendSSE(SSEEventType.TASK_RESUMED, {
            taskId,
            status: "resumed",
            message: "Task resumed successfully",
          });

          // Send the message
          await adapter.sendMessage(text, images, {
            taskId,
            eventHandlers,
          });
        } catch (taskError) {
          logger.error("Error processing RooCode task message:", taskError);
          sendSSE(SSEEventType.ERROR, {
            error:
              taskError instanceof Error
                ? taskError.message
                : "Unknown error occurred",
          });
          reply.raw.end();
        }
      } catch (error) {
        logger.error("Error processing RooCode task message request:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  // POST /api/v1/roo/task/:taskId/action - Handle task actions
  fastify.post(
    "/roo/task/:taskId/action",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Perform actions on a RooCode task",
        description:
          "Perform specific actions on an existing RooCode task, such as pressing buttons for approvals",
        params: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The task ID to perform the action on",
            },
          },
          required: ["taskId"],
        },
        body: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "pressPrimaryButton",
                "pressSecondaryButton",
                "cancel",
                "resume",
              ],
              description: "The action to perform on the task",
            },
            extensionId: {
              type: "string",
              description:
                "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
            },
          },
          required: ["action"],
        },
        response: {
          200: {
            description: "Action performed successfully",
            $ref: "TaskResponse#",
          },
          400: {
            description: "Bad request - invalid input or action not allowed",
            $ref: "ErrorResponse#",
          },
          404: {
            description: "Task not found",
            $ref: "ErrorResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request, reply) => {
      const { taskId } = request.params as {
        taskId: string;
      };
      const { action, extensionId } = request.body as ActionRequest;

      try {
        const adapter = controller.getRooAdapter(extensionId);
        if (!adapter?.isActive) {
          return reply.status(500).send({
            message: "RooCode extension is not available",
          });
        }

        // Check if task exists in active tasks or history
        const activeTaskIds = adapter.getActiveTaskIds();
        const isTaskInHistory = await adapter.isTaskInHistory(taskId);

        if (!activeTaskIds.includes(taskId) && !isTaskInHistory) {
          return reply.status(404).send({
            message: `Task with ID ${taskId} not found`,
          });
        }

        // If task is in history, resume it first
        if (!activeTaskIds.includes(taskId) && isTaskInHistory) {
          await adapter.resumeTask(taskId);
        }

        switch (action) {
          case "pressPrimaryButton":
            await adapter.pressPrimaryButton();
            logger.info(`Primary button pressed for task ${taskId}`);
            return reply.send({
              id: taskId,
              status: "completed",
              message: "Primary button pressed successfully",
            });

          case "pressSecondaryButton":
            await adapter.pressSecondaryButton();
            logger.info(`Secondary button pressed for task ${taskId}`);
            return reply.send({
              id: taskId,
              status: "completed",
              message: "Secondary button pressed successfully",
            });

          case "cancel":
            // Check if the taskId is in the current active tasks
            if (activeTaskIds.includes(taskId)) {
              await adapter.cancelCurrentTask();
              logger.info(`Task cancelled: ${taskId}`);
              return reply.send({
                message: "Task cancelled successfully",
              });
            } else {
              return reply.status(400).send({
                message: "Only current active tasks can be cancelled",
              });
            }

          case "resume":
            await adapter.resumeTask(taskId);
            logger.info(`Task resumed: ${taskId}`);
            return reply.send({
              id: taskId,
              status: "running",
              message: "Task resumed successfully",
            });

          default:
            return reply.status(400).send({
              message: `Unknown action: ${action}`,
            });
        }
      } catch (error) {
        logger.error("Error handling task action:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  // GET /api/v1/roo/tasks - Get RooCode task history
  fastify.get(
    "/roo/tasks",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get RooCode task history",
        description:
          "Retrieves the complete task history from RooCode extension configuration",
        querystring: {
          type: "object",
          properties: {
            extensionId: {
              type: "string",
              description:
                "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
            },
          },
          required: [],
        },
        response: {
          200: {
            description: "Task history retrieved successfully",
            type: "object",
            properties: {
              data: {
                type: "array",
                items: { $ref: "HistoryItem#" },
              },
              extensionId: {
                type: "string",
                description:
                  "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
              },
            },
            required: ["data"],
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { extensionId } = request.query as { extensionId?: string };

        // Get the appropriate adapter
        const adapter = controller.getRooAdapter(extensionId);

        if (!adapter) {
          return reply.status(500).send({
            message: "RooCode extension is not available",
          });
        }

        return reply.send({
          data: adapter.getTaskHistory(),
        });
      } catch (error) {
        logger.error("Error retrieving task history:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  // GET /api/v1/roo/task/:taskId - Get RooCode task by ID
  fastify.get(
    "/roo/task/:taskId",
    {
      schema: {
        tags: ["Tasks"],
        summary: "Get RooCode task by ID",
        params: {
          type: "object",
          properties: {
            taskId: { type: "string" },
          },
          required: ["taskId"],
        },
        querystring: {
          type: "object",
          properties: {
            extensionId: {
              type: "string",
              description:
                "Assign task to the Roo variant extension like Kilo Code, by default is RooCode extension",
            },
          },
          required: [],
        },
        response: {
          200: {
            type: "object",
            description: "Task details with history and conversation data",
            properties: {
              historyItem: {
                description: "Task history item data",
                $ref: "HistoryItem#",
              },
              taskDirPath: {
                type: "string",
                description: "Path to the task directory",
              },
              apiConversationHistoryFilePath: {
                type: "string",
                description: "Path to the API conversation history file",
              },
              uiMessagesFilePath: {
                type: "string",
                description: "Path to the UI messages file",
              },
              apiConversationHistory: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    role: {
                      type: "string",
                      enum: ["user", "assistant"],
                    },
                    content: {
                      oneOf: [
                        { type: "string" },
                        {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              type: { type: "string" },
                              text: { type: "string" },
                              source: {
                                type: "object",
                                properties: {
                                  type: { type: "string" },
                                  media_type: { type: "string" },
                                  data: { type: "string" },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                  required: ["role", "content"],
                },
                description: "Array of Anthropic MessageParam objects",
              },
            },
            required: [
              "historyItem",
              "taskDirPath",
              "apiConversationHistoryFilePath",
              "uiMessagesFilePath",
              "apiConversationHistory",
            ],
          },
          400: { $ref: "ErrorResponse#" },
          404: { $ref: "ErrorResponse#" },
          503: { $ref: "ErrorResponse#" },
          500: { $ref: "ErrorResponse#" },
        },
      },
    },
    async (request, reply) => {
      try {
        const { taskId } = request.params as { taskId: string };
        const { extensionId } = request.query as { extensionId?: string };

        // Validate taskId
        if (!taskId || typeof taskId !== "string") {
          return reply.code(400).send({
            error: "Invalid taskId",
            message: "taskId must be a non-empty string",
          });
        }

        // Get the appropriate adapter
        const adapter = controller.getRooAdapter(extensionId);

        if (!adapter) {
          return reply.status(500).send({
            message: "RooCode extension is not available",
          });
        }

        const taskData = await adapter.getTaskWithId(taskId);

        return reply.send(taskData);
      } catch (error) {
        logger.error(
          `Error getting task ${(request.params as any).taskId}:`,
          error,
        );
        return reply.code(500).send({
          error: "Internal server error",
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  // POST /api/v1/roo/install-mcp-config - Auto install Agent Maestro MCP config to the extension
  fastify.post(
    "/roo/install-mcp-config",
    {
      schema: {
        tags: ["MCP Configuration"],
        summary: "Add Agent Maestro MCP configuration",
        description:
          "Adds Agent Maestro MCP server configuration to the specified extension's settings",
        body: {
          type: "object",
          properties: {
            extensionId: {
              type: "string",
              description:
                "The extension ID to add configuration to. If not provided, uses the first available installed extension that supports MCP configuration.",
            },
          },
        },
        response: {
          200: {
            description: "Configuration added successfully",
            type: "object",
            properties: {
              extensionId: {
                type: "string",
                description: "The extension ID that was configured",
              },
              extensionDisplayName: {
                type: "string",
                description: "The display name of the configured extension",
              },
              success: {
                type: "boolean",
                description: "Whether the operation was successful",
              },
              message: {
                type: "string",
                description: "Success message",
              },
            },
            required: [
              "extensionId",
              "extensionDisplayName",
              "success",
              "message",
            ],
          },
          400: {
            description:
              "Bad request - invalid extension ID, no supported extensions installed, or configuration already exists",
            $ref: "ErrorResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request, reply) => {
      try {
        if (!context) {
          return reply.status(500).send({
            message: "Extension context not available",
          });
        }

        const { extensionId } = request.body as { extensionId?: string };

        // Get available extensions (now returns ExtensionInfo[] with id and displayName)
        const availableExtensions = getAvailableExtensions();

        // Handle case where no supported extensions are installed
        if (availableExtensions.length === 0) {
          return reply.status(400).send({
            message:
              "No supported extensions are currently installed. Please install a compatible extension like Roo Code or Kilo Code.",
          });
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
          return reply.status(400).send({
            message: `Unsupported extension ID: ${targetExtensionId}. Available extensions: ${extensionNames.join(", ")}`,
          });
        }

        const result = await addAgentMaestroMcpConfig({
          extensionId: targetExtensionId,
          globalStorageUri: context.globalStorageUri,
        });

        if (!result.success) {
          return reply.status(400).send({
            message: result.message,
          });
        }

        logger.info(
          `Added Agent Maestro MCP configuration for ${targetExtensionId}`,
        );

        return reply.send({
          extensionId: targetExtensionId,
          extensionDisplayName: targetExtension.displayName,
          success: true,
          message: result.message,
        });
      } catch (error) {
        logger.error("Error adding MCP configuration:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );
}
