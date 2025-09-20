import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import OpenAI from "openai";
import * as vscode from "vscode";

import { getChatModelClient } from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import {
  CreateChatCompletionRequest,
  CreateChatCompletionResponse,
  CreateChatCompletionStreamResponse,
} from "../schemas/openai";

/**
 * Convert OpenAI messages to VSCode Language Model messages
 */
const convertOpenAIMessagesToVSCode = (
  messages: OpenAI.ChatCompletionMessageParam[],
): vscode.LanguageModelChatMessage[] => {
  return messages.map((msg) => {
    // Handle different content formats
    let content: string;
    if (typeof msg.content === "string") {
      content = msg.content || "";
    } else if (Array.isArray(msg.content)) {
      // Extract text parts - TODO: handle images and other types
      content = msg.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
    } else {
      content = "";
    }

    // Map roles to VSCode LM format
    switch (msg.role) {
      case "system":
        return vscode.LanguageModelChatMessage.User(
          content,
          vscode.LanguageModelChatMessageRole.User,
        );
      case "user":
        return vscode.LanguageModelChatMessage.User(
          content,
          vscode.LanguageModelChatMessageRole.User,
        );
      case "assistant":
        return vscode.LanguageModelChatMessage.Assistant(content);
      default:
        return vscode.LanguageModelChatMessage.User(
          content,
          vscode.LanguageModelChatMessageRole.User,
        );
    }
  });
};

// OpenAPI route definition for /chat/completions
const chatCompletionsRoute = createRoute({
  method: "post",
  path: "/chat/completions",
  tags: ["OpenAI API"],
  summary: "Create a chat completion with OpenAI-compatible API",
  description:
    "Create a chat completion using the OpenAI-compatible API interface, powered by VSCode Language Models. Supports both streaming and non-streaming responses.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateChatCompletionRequest,
        },
      },
    },
    description: "Chat completion parameters",
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CreateChatCompletionResponse,
        },
        "text/event-stream": {
          schema: CreateChatCompletionStreamResponse,
        },
      },
      description: "Successfully created chat completion",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
              code: z.string().optional(),
            }),
          }),
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
              code: z.string().optional(),
            }),
          }),
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.object({
              message: z.string(),
              type: z.string(),
              code: z.string().optional(),
            }),
          }),
        },
      },
      description: "Internal server error",
    },
  },
});

export function registerOpenaiRoutes(app: OpenAPIHono) {
  // POST /chat/completions - OpenAI-compatible chat completions endpoint
  app.openapi(chatCompletionsRoute, async (c: Context): Promise<Response> => {
    try {
      // Parse request body
      const requestBody = await c.req.json();

      // TODO: Implement chat completions handler logic
      // This should include:
      // 1. Validate and parse the request using CreateChatCompletionRequest schema
      // 2. Convert OpenAI request format to VSCode Language Model format
      // 3. Get appropriate chat model client from chatModelsCache
      // 4. Handle both streaming and non-streaming responses
      // 5. Convert VSCode LM responses back to OpenAI format
      // 6. Return proper CreateChatCompletionResponse or CreateChatCompletionStreamResponse

      return c.json(
        {
          error: {
            message: "Chat completions endpoint not yet implemented",
            type: "not_implemented_error",
            code: "not_implemented",
          },
        },
        501,
      );
    } catch (error) {
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "internal_error",
          },
        },
        500,
      );
    }
  });
}
