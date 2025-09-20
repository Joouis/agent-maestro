import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
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
        return vscode.LanguageModelChatMessage.User(content);
      case "user":
        return vscode.LanguageModelChatMessage.User(content);
      case "assistant":
        return vscode.LanguageModelChatMessage.Assistant(content);
      default:
        return vscode.LanguageModelChatMessage.User(content);
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
      // Parse and validate request body
      const requestBody =
        (await c.req.json()) as OpenAI.ChatCompletionCreateParams;

      logger.debug(
        "/chat/completions payload: ",
        JSON.stringify(requestBody, null, 2),
      );

      const {
        model: modelId,
        messages,
        stream = false,
        ...otherParams
      } = requestBody;

      // 1. Get chat model client
      const { client, error: clientError } = await getChatModelClient(modelId);

      if (clientError) {
        return c.json(clientError, 404);
      }

      logger.info(
        `Received /chat/completions call with selected model: ${client.name} (${client.vendor}/${client.family})`,
      );

      // 2. Convert OpenAI messages to VSCode LM format
      const vsCodeLmMessages = convertOpenAIMessagesToVSCode(messages);

      // Count input tokens
      let inputTokenCount = 0;
      const cancellationToken = new vscode.CancellationTokenSource().token;
      for (const msg of vsCodeLmMessages) {
        inputTokenCount += await client.countTokens(msg, cancellationToken);
      }

      // 3. Build VSCode Language Model request options
      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "OpenAI-compatible /chat/completions endpoint using VS Code Language Model API",
        modelOptions: {
          temperature: otherParams.temperature,
          // Map max_completion_tokens or max_tokens to VSCode options
          ...(otherParams.max_completion_tokens && {
            maxTokens: otherParams.max_completion_tokens,
          }),
          ...(otherParams.max_tokens && { maxTokens: otherParams.max_tokens }),
        },
        // TODO: Convert tools and tool_choice when needed
      };

      // 4. Send request to VSCode LM API
      const response = await client.sendRequest(
        vsCodeLmMessages,
        lmRequestOptions,
        cancellationToken,
      );

      // 5. Handle non-streaming response
      if (!stream) {
        let fullText = "";
        for await (const fragment of response.text) {
          fullText += fragment;
        }

        // Count output tokens
        const outputTokenCount = await client.countTokens(fullText);

        // Build OpenAI-compatible response
        const openaiResponse: OpenAI.ChatCompletion = {
          id: `AM-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: fullText,
                refusal: null,
              },
              finish_reason: "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: inputTokenCount,
            completion_tokens: outputTokenCount,
            total_tokens: inputTokenCount + outputTokenCount,
          },
        };

        logger.debug(
          "/chat/completions response: ",
          JSON.stringify(openaiResponse, null, 2),
        );

        return c.json(openaiResponse);
      }

      // 6. If streaming, pipe chunks as SSE
      return streamSSE(c, async (stream) => {
        try {
          const chatCompletionId = `AM-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);

          // Send initial chunk with role
          const initialChunk: OpenAI.ChatCompletionChunk = {
            id: chatCompletionId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "",
                },
                finish_reason: null,
                logprobs: null,
              },
            ],
          };
          await stream.writeSSE({
            data: JSON.stringify(initialChunk),
          });

          // Process streaming response
          let fullText = "";
          for await (const fragment of response.text) {
            fullText += fragment;

            const contentChunk: OpenAI.ChatCompletionChunk = {
              id: chatCompletionId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: fragment,
                  },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
            };
            await stream.writeSSE({
              data: JSON.stringify(contentChunk),
            });
          }

          // Count output tokens for final chunk if usage is requested
          let usage: OpenAI.CompletionUsage | undefined;
          if (requestBody.stream_options?.include_usage) {
            const outputTokenCount = await client.countTokens(fullText);
            usage = {
              prompt_tokens: inputTokenCount,
              completion_tokens: outputTokenCount,
              total_tokens: inputTokenCount + outputTokenCount,
            };
          }

          // Send final chunk with finish_reason
          const finalChunk: OpenAI.ChatCompletionChunk = {
            id: chatCompletionId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            ...(usage && { usage }),
          };
          await stream.writeSSE({
            data: JSON.stringify(finalChunk),
          });

          // Send [DONE] signal
          await stream.writeSSE({
            data: "[DONE]",
          });

          logger.info("OpenAI streaming response completed");
        } catch (streamError) {
          logger.error("Error in OpenAI streaming:", streamError);
          throw streamError;
        }
      });
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
