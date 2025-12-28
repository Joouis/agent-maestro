import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import { Context } from "hono";
import * as path from "path";
import * as vscode from "vscode";

import packageJson from "../../../package.json";
import { logger } from "../../utils/logger";

interface ErrorLogContext {
  requestBody?: any;
  lmChatMessages?: vscode.LanguageModelChatMessage[];
  error: Error | unknown;
  endpoint: string;
  modelId?: string;
}

/**
 * Generates a timestamped log filename
 */
function generateLogFilename(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const milliseconds = String(now.getMilliseconds()).padStart(3, "0");

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}-${milliseconds}-debug.log`;
}

// Generate log filename once at extension launch
const LOG_FILENAME = generateLogFilename();

/**
 * Gets extension metadata for logging
 */
function getExtensionMetadata() {
  return {
    name: packageJson.name,
    displayName: packageJson.displayName,
    version: packageJson.version,
    vscodeVersion: vscode.version,
  };
}

/**
 * Sanitizes Anthropic request body to protect user privacy
 * Removes message content while keeping metadata useful for debugging
 */
function sanitizeAnthropicRequestBody(requestBody: any): any {
  if (!requestBody || typeof requestBody !== "object") {
    return requestBody;
  }

  const body = requestBody as Anthropic.Messages.MessageCreateParams;

  // Sanitize messages array inline
  const sanitizedMessages = body.messages?.map((message) => {
    let content;
    // Sanitize content
    if (typeof message.content === "string") {
      content = "[REDACTED]";
    } else if (Array.isArray(message.content)) {
      content = message.content.map((contentBlock) => {
        // Sanitize each content block type
        switch (contentBlock.type) {
          case "text":
            return { type: "text", text: "[REDACTED]" };

          case "image":
            if (contentBlock.source.type === "base64") {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: contentBlock.source.media_type,
                  data: "[REDACTED]",
                },
              };
            } else {
              return {
                type: "image",
                source: {
                  type: "url",
                  url: "[REDACTED]",
                },
              };
            }

          // Do not support "document" content currently, redact entirely
          case "document":
            return {
              type: "document",
              source: {},
            };

          case "search_result":
            return {
              type: "search_result",
              source: "[REDACTED]",
              title: "[REDACTED]",
              content: [],
            };

          case "thinking":
            return {
              type: "thinking",
              thinking: "[REDACTED]",
              signature: contentBlock.signature,
            };

          case "redacted_thinking":
            return contentBlock;

          case "tool_use":
            return {
              type: "tool_use",
              id: contentBlock.id,
              name: contentBlock.name,
              input: {},
            };

          case "tool_result":
            return {
              type: "tool_result",
              tool_use_id: contentBlock.tool_use_id,
              content: "[REDACTED]",
              ...(contentBlock.is_error !== undefined && {
                is_error: contentBlock.is_error,
              }),
            };

          case "server_tool_use":
            return {
              type: "server_tool_use",
              id: contentBlock.id,
              name: contentBlock.name,
              input: {},
            };

          case "web_search_tool_result":
            return {
              type: "web_search_tool_result",
              tool_use_id: contentBlock.tool_use_id,
              content: [],
            };

          default:
            return contentBlock;
        }
      });
    }

    return {
      ...message,
      content,
    };
  });

  return {
    ...body,
    messages: sanitizedMessages,
  };
}

/**
 * Sanitizes VSCode LanguageModelChatMessage array to protect user privacy
 * Removes message content while keeping metadata useful for debugging
 */
function sanitizeLmChatMessages(
  messages?: vscode.LanguageModelChatMessage[],
): any[] | undefined {
  return messages?.map((message) => {
    // Extract role
    const role =
      message.role === vscode.LanguageModelChatMessageRole.User
        ? "user"
        : "assistant";

    // Sanitize content parts
    const sanitizedContent = message.content.map((part: any) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return {
          type: "text",
          value: "[REDACTED]",
        };
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        return {
          type: "tool_call",
          callId: part.callId,
          name: part.name,
          input: {}, // Redact input
        };
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        return {
          type: "tool_result",
          callId: part.callId,
          content: part.content.map(() => ({
            type: "text",
            value: "[REDACTED]",
          })),
        };
      } else {
        // Handle any other part types (like LanguageModelDataPart)
        return {
          type: "unknown",
          className: part.constructor?.name || "UnknownPart",
        };
      }
    });

    return {
      role,
      content: sanitizedContent,
    };
  });
}

/**
 * Sanitizes request body based on the endpoint
 * @param requestBody - The request body to sanitize
 * @param endpoint - The API endpoint to determine sanitization strategy
 * @returns Sanitized request body
 */
function sanitizeRequestBody(requestBody: any, endpoint: string): any {
  // Sanitize Anthropic API payloads
  if (endpoint.includes("/v1/messages")) {
    return sanitizeAnthropicRequestBody(requestBody);
  }

  // TODO: Add sanitization for Gemini and OpenAI request formats to protect user privacy
  // For other endpoints, return as-is
  return requestBody;
}

/**
 * Logs error details to a shared log file, appending each error as a formatted JSON entry
 * @returns The absolute path to the log file
 */
export async function logErrorToFile(
  context: ErrorLogContext,
): Promise<string> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("No workspace folder found");
  }
  const cwd = workspaceFolder.uri.fsPath;
  const logPath = path.join(cwd, LOG_FILENAME);

  const errorMessage =
    context.error instanceof Error
      ? context.error.message
      : String(context.error);
  const errorStack =
    context.error instanceof Error ? context.error.stack : undefined;

  const logData = {
    timestamp: new Date().toISOString(),
    endpoint: context.endpoint,
    extension: getExtensionMetadata(),
    modelId: context.modelId,
    error: {
      message: errorMessage,
      stack: errorStack,
      raw: context.error,
    },
    requestBody: sanitizeRequestBody(context.requestBody, context.endpoint),
    lmChatMessages: sanitizeLmChatMessages(context.lmChatMessages),
  };

  // Format as pretty-printed JSON with separator for readability
  const logContent = JSON.stringify(logData, null, 2) + "\n";

  try {
    await fs.promises.appendFile(logPath, logContent, "utf8");
    return logPath;
  } catch (writeError) {
    // If we can't write the log file, at least log to logger
    logger.error("Failed to write error log file:", writeError);
    logger.error("Original error context:", logData);
    throw writeError;
  }
}

/**
 * Logs error details to a diagnostic file with sanitized user data
 * @param ctx - Error context containing request body, error, endpoint, and optional model ID
 * @returns The absolute path to the log file, or undefined if logging failed
 */
export async function handleErrorWithLogging(
  ctx: ErrorLogContext,
): Promise<string | undefined> {
  // Log error details to file
  try {
    return await logErrorToFile(ctx);
  } catch (logError) {
    logger.error("Failed to write error log file:", logError);
    return undefined;
  }
}
