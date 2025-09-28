import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";

import { getChatModelClient } from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import {
  AnthropicCountTokensResponseSchema,
  AnthropicErrorResponseSchema,
  AnthropicMessageCreateParamsSchema,
  AnthropicMessageResponseSchema,
} from "../schemas/anthropic";
import {
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
} from "../utils/anthropic";

const prepareAnthropicMessages = async ({
  requestBody,
  client,
}: {
  requestBody: Anthropic.Messages.MessageCreateParams;
  client: vscode.LanguageModelChat;
}) => {
  const { system, messages } = requestBody;

  const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
    ...convertAnthropicSystemToVSCode(system),
    ...convertAnthropicMessagesToVSCode(messages),
  ];

  let inputTokenCount = 0;
  const cancellationToken = new vscode.CancellationTokenSource().token;
  for (const msg of vsCodeLmMessages) {
    inputTokenCount += await client.countTokens(msg, cancellationToken);
  }

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
          schema: AnthropicMessageCreateParamsSchema,
        },
      },
    },
    description: "Message creation parameters",
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AnthropicMessageResponseSchema,
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
          schema: AnthropicMessageCreateParamsSchema,
        },
      },
    },
    description: "Message parameters for token counting",
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: AnthropicCountTokensResponseSchema,
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
    try {
      // Parse request body
      const requestBody =
        (await c.req.json()) as Anthropic.Messages.MessageCreateParams;
      const {
        model: modelId,
        system,
        messages,
        tools,
        tool_choice,
        ...msgCreateParams
      } = requestBody;

      logger.debug(
        "/v1/messages payload: ",
        JSON.stringify(requestBody, null, 2),
      );

      // 1. Check if selected model is available in VS Code LM API
      const { client, error: clientError } = await getChatModelClient(modelId);

      if (clientError) {
        return c.json(clientError, 404);
      }

      logger.info(
        `Received /v1/messages call with selected model: ${client.name} (${client.vendor}/${client.family})`,
      );

      // 2. Map Anthropic messages to VS Code LM API messages and count input tokens
      const { vsCodeLmMessages, inputTokenCount, cancellationToken } =
        await prepareAnthropicMessages({
          requestBody,
          client,
        });

      // 3. Build VS Code Language Model request options
      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
        modelOptions: msgCreateParams,
        tools: convertAnthropicToolToVSCode(tools),
        toolMode: convertAnthropicToolChoiceToVSCode(tool_choice),
      };

      // 4. Send request to the VS Code LM API
      const response = await client.sendRequest(
        vsCodeLmMessages,
        lmRequestOptions,
        cancellationToken,
      );

      // 5. Non-streaming response: collect content blocks using unified approach
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
          ? await client.countTokens(accumulatedText)
          : 1;

        // https://docs.anthropic.com/en/api/messages#response-id
        const resp: Anthropic.Messages.Message = {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: modelId,
          content,
          stop_reason:
            content.at(-1)?.type === "tool_use" ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: {
            // cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            input_tokens: inputTokenCount,
            output_tokens: outputTokenCount,
            server_tool_use: null,
            service_tier: null,
          },
          // container: null,
        };

        logger.debug("/v1/messages response: ", JSON.stringify(resp, null, 2));

        return c.json(resp);
      }

      // 6. If streaming, pipe chunks as SSE
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

          try {
            await writeSSE({
              type: "message_start",
              message: {
                id: `msg_${Date.now()}`,
                type: "message",
                role: "assistant",
                model: modelId,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: inputTokenCount,
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
              ? await client.countTokens(accumulatedText)
              : 1;

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
                input_tokens: inputTokenCount,
                output_tokens: outputTokenCount,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                server_tool_use: null,
              },
            });

            await writeSSE({ type: "message_stop" });

            logger.info("Streaming response completed");
          } catch (streamError) {
            logger.error("Error in streaming:", streamError);
            throw streamError;
          }
        },
        async (error, _stream) => {
          logger.error("Stream error occurred:", error);
        },
      );
    } catch (error) {
      logger.error("Anthropic API /v1/messages request failed:", error);
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "internal_error",
          },
          type: "error",
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
      });

      return c.json(
        {
          input_tokens: inputTokenCount,
        },
        200,
      );
    } catch (error) {
      logger.error("Anthropic API token count request failed:", error);
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Internal server error",
            type: "internal_error",
          },
          type: "error",
        },
        500,
      );
    }
  });
}
