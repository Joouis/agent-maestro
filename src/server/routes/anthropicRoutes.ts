import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";

import { getChatModelClient } from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import { AnthropicErrorResponseSchema } from "../schemas/anthropic";
import {
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
  countAnthropicMessageTokens,
} from "../utils/anthropic";
import { handleErrorWithLogging } from "../utils/errorDiagnostics";

const prepareAnthropicMessages = async ({
  requestBody,
  client,
  modelId,
}: {
  requestBody: Anthropic.Messages.MessageCreateParams;
  client: vscode.LanguageModelChat;
  modelId: string;
}) => {
  const requestBodyStr = JSON.stringify(requestBody);
  logger.debug("/v1/messages payload: ", requestBodyStr);

  const { system, messages } = requestBody;

  const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
    ...convertAnthropicSystemToVSCode(system),
    ...convertAnthropicMessagesToVSCode(messages),
  ];

  const cancellationToken = new vscode.CancellationTokenSource().token;
  const inputTokenCount = await countAnthropicMessageTokens(
    requestBodyStr,
    client,
    true,
    modelId,
  );

  return {
    vsCodeLmMessages,
    inputTokenCount,
    cancellationToken,
  };
};

// OpenAPI route definition
const messagesRoute = createRoute({
  method: "post",
  path: "/v1/messages",
  tags: ["Anthropic API"],
  summary: "Create a message with Anthropic-compatible API",
  description:
    "Create a message using the Anthropic-compatible API interface, powered by VSCode Language Models. Supports both streaming and non-streaming responses.",
  request: {
    body: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Anthropic Messages API request body. See https://docs.anthropic.com/en/api/messages for schema details.",
            ),
        },
      },
    },
    description: "Message creation parameters",
  },
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Anthropic Messages API response body. See https://docs.anthropic.com/en/api/messages for schema details.",
            ),
        },
        "text/event-stream": {
          schema: z
            .string()
            .describe("Server-sent events stream for streaming responses"),
        },
      },
      description: "Successfully created message",
    },
    400: {
      content: {
        "application/json": {
          schema: AnthropicErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: AnthropicErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: AnthropicErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

const countTokensRoute = createRoute({
  method: "post",
  path: "/v1/messages/count_tokens",
  tags: ["Anthropic API"],
  summary: "Count input tokens for Anthropic-compatible messages",
  description:
    "Count the input tokens for messages using the Anthropic-compatible API interface, powered by VSCode Language Models.",
  request: {
    body: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Anthropic Messages API request body. See https://docs.claude.com/en/api/messages-count-tokens for schema details.",
            ),
        },
      },
    },
    description: "Message parameters for token counting",
  },
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Anthropic Messages API response body. See https://docs.claude.com/en/api/messages-count-tokens for schema details.",
            ),
        },
      },
      description: "Successfully counted input tokens",
    },
    400: {
      content: {
        "application/json": {
          schema: AnthropicErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: AnthropicErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: AnthropicErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

export function registerAnthropicRoutes(app: OpenAPIHono) {
  // POST /v1/messages - Anthropic-compatible messages endpoint
  app.openapi(messagesRoute, async (c: Context): Promise<Response> => {
    let effectiveModelId = "";
    let rawRequestBody;
    let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
    let inputTokens = 0;

    try {
      // Parse request body
      const requestBody =
        (await c.req.json()) as Anthropic.Messages.MessageCreateParams;
      rawRequestBody = requestBody;

      const {
        model,
        system,
        messages,
        tools,
        tool_choice,
        ...msgCreateParams
      } = requestBody;

      // 1. Get chat model client (handles model mapping internally)
      const { client, error: clientError } = await getChatModelClient(model);

      if (client) {
        effectiveModelId = client.id;
      }

      if (clientError) {
        return c.json(clientError, 404);
      }

      // 3. Map Anthropic messages to VS Code LM API messages and count input tokens
      const { vsCodeLmMessages, inputTokenCount, cancellationToken } =
        await prepareAnthropicMessages({
          requestBody,
          client,
          modelId: effectiveModelId,
        });
      lmChatMessages = vsCodeLmMessages;
      inputTokens = inputTokenCount.calibrated;

      logger.info(
        `→ /v1/messages | model: ${
          model === effectiveModelId ? model : `${model} → ${effectiveModelId}`
        } | input: ${inputTokenCount.original} → ${inputTokenCount.calibrated}`,
      );

      // 4. Build VS Code Language Model request options
      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
        modelOptions: msgCreateParams,
        tools: convertAnthropicToolToVSCode(tools),
        toolMode: convertAnthropicToolChoiceToVSCode(tool_choice),
      };

      // 5. Send request to the VS Code LM API
      const response = await client.sendRequest(
        vsCodeLmMessages,
        lmRequestOptions,
        cancellationToken,
      );

      // 6. Non-streaming response: collect content blocks using unified approach
      if (!msgCreateParams.stream) {
        const content: Anthropic.Messages.ContentBlock[] = [];
        let accumulatedText = "";

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            let lastBlock = content.at(-1);
            if (!lastBlock || lastBlock.type !== "text") {
              lastBlock = { type: "text", text: "", citations: null };
              content.push(lastBlock);
            }
            lastBlock.text += chunk.value;
            accumulatedText += chunk.value;
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            content.push({
              type: "tool_use",
              id: chunk.callId,
              name: chunk.name,
              input: chunk.input,
            });

            accumulatedText += JSON.stringify(chunk);
          }
        }

        // Count output tokens
        const outputTokenCount = accumulatedText
          ? await countAnthropicMessageTokens(
              accumulatedText,
              client,
              false,
              effectiveModelId,
            )
          : { original: 1, calibrated: 1 };

        // https://docs.anthropic.com/en/api/messages#response-id
        const resp: Anthropic.Messages.Message = {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason:
            content.at(-1)?.type === "tool_use" ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            input_tokens: inputTokenCount.calibrated,
            output_tokens: outputTokenCount.calibrated,
            server_tool_use: null,
            service_tier: null,
          },
          // container: null,
        };

        logger.debug("/v1/messages response: ", JSON.stringify(resp, null, 2));
        logger.info(
          `← /v1/messages | input: ${inputTokenCount.original} → ${inputTokenCount.calibrated} | output: ${outputTokenCount.original} → ${outputTokenCount.calibrated}`,
        );

        return c.json(resp);
      }

      // 7. If streaming, pipe chunks as SSE
      return streamSSE(
        c,
        async (stream) => {
          const writeSSE = async (
            message: Anthropic.Messages.RawMessageStreamEvent,
          ) => {
            await stream.writeSSE({
              event: message.type,
              data: JSON.stringify(message),
            });
          };

          await writeSSE({
            type: "message_start",
            message: {
              id: `msg_${Date.now()}`,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: {
                cache_creation: null,
                input_tokens: inputTokenCount.calibrated,
                output_tokens: 1,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: null,
                service_tier: "standard",
              },
            },
          });

          const contentBlocks: Anthropic.Messages.ContentBlock[] = [];
          let accumulatedText = "";

          for await (const chunk of response.stream) {
            const lastBlock = contentBlocks.at(-1);
            if (chunk instanceof vscode.LanguageModelTextPart) {
              // Stop last non-text block if it exists
              if (lastBlock && lastBlock.type !== "text") {
                await writeSSE({
                  type: "content_block_stop",
                  index: contentBlocks.length - 1,
                });
              }

              // Start a new text block
              if (!lastBlock || lastBlock.type !== "text") {
                contentBlocks.push({
                  type: "text",
                  text: "",
                  citations: null,
                });
                await writeSSE({
                  type: "content_block_start",
                  index: contentBlocks.length - 1,
                  content_block: { type: "text", text: "", citations: null },
                });
              }

              // Append text to the current text block
              (contentBlocks.at(-1) as Anthropic.Messages.TextBlock).text +=
                chunk.value;
              await writeSSE({
                type: "content_block_delta",
                index: contentBlocks.length - 1,
                delta: { type: "text_delta", text: chunk.value },
              });

              accumulatedText += chunk.value;
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              // Every tool call is a new content block
              if (lastBlock) {
                await writeSSE({
                  type: "content_block_stop",
                  index: contentBlocks.length - 1,
                });
              }

              contentBlocks.push({
                type: "tool_use",
                id: chunk.callId,
                name: chunk.name,
                input: chunk.input,
              });

              await writeSSE({
                type: "content_block_start",
                index: contentBlocks.length - 1,
                content_block: {
                  type: "tool_use",
                  id: chunk.callId,
                  name: chunk.name,
                  input: {},
                },
              });

              await writeSSE({
                type: "content_block_delta",
                index: contentBlocks.length - 1,
                delta: {
                  type: "input_json_delta",
                  partial_json: JSON.stringify(chunk.input),
                },
              });

              accumulatedText += JSON.stringify(chunk);
            }
          }

          logger.debug(
            "/v1/messages streamed content block responses: ",
            JSON.stringify(contentBlocks, null, 2),
          );

          // Finalize last content block if it exists
          await writeSSE({
            type: "content_block_stop",
            index: contentBlocks.length - 1,
          });

          // Count output tokens for the complete response
          const outputTokenCount = accumulatedText
            ? await countAnthropicMessageTokens(
                accumulatedText,
                client,
                false,
                effectiveModelId,
              )
            : { original: 1, calibrated: 1 };

          await writeSSE({
            type: "message_delta",
            delta: {
              stop_reason:
                contentBlocks.at(-1)?.type === "tool_use"
                  ? "tool_use"
                  : "end_turn",
              stop_sequence: null,
            },
            usage: {
              input_tokens: inputTokenCount.calibrated,
              output_tokens: outputTokenCount.calibrated,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              server_tool_use: null,
            },
          });

          await writeSSE({ type: "message_stop" });

          logger.info(
            `← /v1/messages (stream) | input: ${inputTokenCount.original} → ${inputTokenCount.calibrated} | output: ${outputTokenCount.original} → ${outputTokenCount.calibrated}`,
          );
        },
        async (error, _stream) => {
          logger.error("Stream error occurred:", error);
        },
      );
    } catch (error) {
      logger.error("✕ /v1/messages | ", error);

      const logFilePath = await handleErrorWithLogging({
        requestBody: rawRequestBody,
        inputTokens,
        lmChatMessages,
        error,
        endpoint: "/api/anthropic/v1/messages",
        modelId: effectiveModelId,
      });

      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);

      const isToolResultError = errorMessage.includes(
        "unexpected `tool_use_id` found in `tool_result` blocks",
      );

      const isModelNotSupportedError = errorMessage.includes(
        "model_not_supported",
      );

      let hintMessage: string | undefined;

      if (isToolResultError) {
        hintMessage =
          "This error may occur when input tokens exceed the model's context limit. Please use the /compact command to reduce the conversation history.";
      } else if (isModelNotSupportedError) {
        hintMessage =
          "This error may be caused by network connectivity issues. Try these steps: 1. Check your network connection and VPN settings; 2. Reload VS Code to refresh the model cache (Cmd/Ctrl+R or Cmd/Ctrl+Shift+P > 'Developer: Reload Window').";
      }

      return c.json(
        {
          error: {
            message: errorMessage,
            type: "internal_server_error",
            log_file: logFilePath,
            ...(hintMessage && { hint: hintMessage }),
          },
        },
        500,
      );
    }
  });

  // POST /v1/messages/count_tokens - Count input tokens
  app.openapi(countTokensRoute, async (c: Context) => {
    try {
      const requestBody =
        (await c.req.json()) as Anthropic.Messages.MessageCreateParams;

      const { client, error: clientError } = await getChatModelClient(
        requestBody.model,
      );

      if (clientError) {
        return c.json(clientError, 404);
      }

      const { inputTokenCount } = await prepareAnthropicMessages({
        requestBody,
        client,
        modelId: client.id,
      });

      return c.json(
        {
          input_tokens: inputTokenCount.calibrated,
        },
        200,
      );
    } catch (error) {
      logger.error("Anthropic API token count request failed:", error);

      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : JSON.stringify(error),
            type: "internal_server_error",
          },
        },
        500,
      );
    }
  });
}
