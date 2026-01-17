import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import * as vscode from "vscode";

import { getChatModelClient } from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import { CommonResponseError } from "../schemas/openai";
import { handleErrorWithLogging } from "../utils/errorDiagnostics";
import {
  convertOpenAIChatCompletionToolToVSCode,
  convertOpenAIMessagesToVSCode,
} from "../utils/openai";

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
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "OpenAI Chat Completion request body. See https://platform.openai.com/docs/api-reference/chat/create for schema details.",
            ),
        },
      },
    },
    description: "Chat completion parameters",
  },
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "OpenAI Chat Completion response body. See https://platform.openai.com/docs/api-reference/chat/create for schema details.",
            ),
        },
        "text/event-stream": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "OpenAI Chat Completion response body. See https://platform.openai.com/docs/api-reference/chat/create for schema details.",
            ),
        },
      },
      description: "Successfully created chat completion",
    },
    400: {
      content: {
        "application/json": {
          schema: CommonResponseError,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: CommonResponseError,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: CommonResponseError,
        },
      },
      description: "Internal server error",
    },
  },
});

export function registerOpenaiRoutes(app: OpenAPIHono) {
  // POST /chat/completions - OpenAI-compatible chat completions endpoint
  app.openapi(chatCompletionsRoute, async (c: Context): Promise<Response> => {
    let rawRequestBody: OpenAI.ChatCompletionCreateParams | undefined;
    let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
    let requestedModelId = "";
    let inputTokens = 0;

    try {
      // Parse and validate request body
      const requestBody =
        (await c.req.json()) as OpenAI.ChatCompletionCreateParams;
      rawRequestBody = requestBody;

      const {
        model: modelId,
        messages,
        stream = false,
        tools,
        tool_choice,
        ...otherParams
      } = requestBody;
      requestedModelId = modelId;

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
      lmChatMessages = vsCodeLmMessages;

      // NOTE: Rough estimation of input tokens for OpenAI API
      // We pass the stringified request body to VSCode's countTokens() API, which is technically
      // a misuse since it's designed for LanguageModelChatMessage objects. However, we intentionally
      // do this to leverage the official tokenizer instead of building our own wheel.
      const requestBodyStr = JSON.stringify(requestBody);
      logger.debug("/chat/completions payload: ", requestBodyStr);
      const cancellationToken = new vscode.CancellationTokenSource().token;
      const inputTokenCount = await client.countTokens(
        requestBodyStr,
        cancellationToken,
      );
      inputTokens = inputTokenCount;

      // 3. Build VSCode Language Model request options
      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "OpenAI-compatible /chat/completions endpoint using VS Code Language Model API",
        modelOptions: otherParams,
        tools: tools
          ? tools.map(convertOpenAIChatCompletionToolToVSCode)
          : undefined,
        toolMode:
          tool_choice === "required"
            ? vscode.LanguageModelChatToolMode.Required
            : vscode.LanguageModelChatToolMode.Auto,
      };

      // 4. Send request to VSCode LM API
      const response = await client.sendRequest(
        vsCodeLmMessages,
        lmRequestOptions,
        cancellationToken,
      );

      // 5. Handle non-streaming response
      if (!stream) {
        let content = "";
        let toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
        let accumulatedText = "";
        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            content += chunk.value;
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
              id: chunk.callId,
              type: "function",
              function: {
                name: chunk.name,
                arguments: JSON.stringify(chunk.input),
              },
            });
          }
          accumulatedText += JSON.stringify(chunk);
        }

        // Count output tokens
        const completionTokens = await client.countTokens(accumulatedText);

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
                content,
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                refusal: null,
              },
              finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
              logprobs: null,
            },
          ],
          usage: {
            prompt_tokens: inputTokenCount,
            completion_tokens: completionTokens,
            total_tokens: inputTokenCount + completionTokens,
          },
        };

        logger.debug(
          "/chat/completions response: ",
          JSON.stringify(openaiResponse, null, 2),
        );

        return c.json(openaiResponse);
      }

      // 6. If streaming, pipe chunks as SSE
      return streamSSE(
        c,
        async (stream) => {
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
          let accumulatedText = "";
          let toolCalls: vscode.LanguageModelToolCallPart[] = [];
          for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
              const contentChunk: OpenAI.ChatCompletionChunk = {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      content: chunk.value,
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              };
              await stream.writeSSE({
                data: JSON.stringify(contentChunk),
              });
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              toolCalls.push(chunk);
              const toolCallChunk: OpenAI.ChatCompletionChunk = {
                id: chatCompletionId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: toolCalls.length - 1,
                          id: chunk.callId,
                          type: "function",
                          function: {
                            name: chunk.name,
                            arguments: JSON.stringify(chunk.input),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                    logprobs: null,
                  },
                ],
              };
              await stream.writeSSE({
                data: JSON.stringify(toolCallChunk),
              });
            }
            accumulatedText += JSON.stringify(chunk);
          }

          // Count output tokens for final chunk if usage is requested
          let usage: OpenAI.CompletionUsage | undefined;
          if (requestBody.stream_options?.include_usage) {
            const completionTokens = await client.countTokens(accumulatedText);

            usage = {
              prompt_tokens: inputTokenCount,
              completion_tokens: completionTokens,
              total_tokens: inputTokenCount + completionTokens,
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
                finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
                logprobs: null,
              },
            ],
            usage,
          };
          await stream.writeSSE({
            data: JSON.stringify(finalChunk),
          });

          // Send [DONE] signal
          await stream.writeSSE({
            data: "[DONE]",
          });

          logger.info("OpenAI streaming response completed");
        },
        async (error, stream) => {
          logger.error("Stream error occurred:", error);

          // Send error chunk to client before closing
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const errorChunk: OpenAI.ChatCompletionChunk = {
            id: `AM-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                delta: {
                  content: `\n\n[Error: ${errorMessage}]`,
                },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
          };
          await stream.writeSSE({
            data: JSON.stringify(errorChunk),
          });
        },
      );
    } catch (error) {
      logger.error("OpenAI API /chat/completions request failed:", error);

      const logFilePath = await handleErrorWithLogging({
        requestBody: rawRequestBody,
        inputTokens,
        lmChatMessages,
        error,
        endpoint: "/api/openai/chat/completions",
        modelId: requestedModelId,
      });

      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "internal_error",
            log_file: logFilePath,
          },
        },
        500,
      );
    }
  });
}
