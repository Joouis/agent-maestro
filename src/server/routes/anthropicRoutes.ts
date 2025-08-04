import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import {
  ErrorResponseSchema,
  AnthropicMessageCreateParamsSchema,
  AnthropicMessageResponseSchema,
} from "../schemas";
import {
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
} from "../utils/anthropic";

interface ContentBlock {
  type: "text" | "tool_use" | string;
  text?: string;
  toolUse?: vscode.LanguageModelToolCallPart;
}

export const honoHandleMessages = async (c: Context): Promise<Response> => {
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

    // logger.info(JSON.stringify(requestBody, null, 2));

    logger.info(`Processing Anthropic API request for model: ${modelId}`);

    // 1. Check if selected model is available in VS Code LM API
    const models = await vscode.lm.selectChatModels({});
    const client = models.find((m) => m.id === modelId);

    if (!client) {
      logger.error("No VS Code LM model available");
      return c.json(
        {
          error: `Model '${modelId}' not found. Use /api/v1/lm/chatModels to list available models and pass a valid model ID.`,
        },
        404,
      );
    }
    logger.info(
      `Selected model: ${client.name} (${client.vendor}/${client.family})`,
    );

    // 2. Map Anthropic messages to VS Code LM API messages
    const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
      ...convertAnthropicSystemToVSCode(system),
      ...convertAnthropicMessagesToVSCode(messages),
    ];
    logger.info(JSON.stringify(vsCodeLmMessages, null, 2));

    // 3. Build VS Code Language Model request options
    const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
      justification:
        "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
      modelOptions: msgCreateParams,
      tools: convertAnthropicToolToVSCode(tools),
      toolMode: convertAnthropicToolChoiceToVSCode(tool_choice),
    };
    const cancellationToken = new vscode.CancellationTokenSource().token;

    // 4. Count input tokens
    let inputTokenCount = 0;
    for (const msg of vsCodeLmMessages) {
      inputTokenCount += await client.countTokens(msg, cancellationToken);
    }

    // 5. Send request to the VS Code LM API
    const response = await client.sendRequest(
      vsCodeLmMessages,
      lmRequestOptions,
      cancellationToken,
    );

    // 6. Non-streaming response: collect full text
    if (!msgCreateParams.stream) {
      let fullText = "";
      for await (const fragment of response.text) {
        fullText += fragment;
      }

      // Count output tokens
      const outputTokenCount = await client.countTokens(fullText);

      // https://docs.anthropic.com/en/api/messages#response-id
      const resp: Anthropic.Messages.Message = {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: modelId,
        // TODO: what about other ContentBlock like ToolUseBlock or ThinkingBlock?
        content: [{ type: "text", text: fullText, citations: null }],
        stop_reason: "end_turn",
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

          const contentBlocks: ContentBlock[] = [];
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
                contentBlocks.push({ type: "text", text: "" });
                await writeSSE({
                  type: "content_block_start",
                  index: contentBlocks.length - 1,
                  content_block: { type: "text", text: "", citations: null },
                });
              }

              // Append text to the current text block
              contentBlocks.at(-1)!.text += chunk.value;
              accumulatedText += chunk.value;
              await writeSSE({
                type: "content_block_delta",
                index: contentBlocks.length - 1,
                delta: { type: "text_delta", text: chunk.value },
              });
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              // Every tool call is a new content block
              if (lastBlock) {
                await writeSSE({
                  type: "content_block_stop",
                  index: contentBlocks.length - 1,
                });
              }

              contentBlocks.push({ type: "tool_use", toolUse: chunk });
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
            }
          }

          logger.info(
            "Content blocks: ",
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
        }
      },
      async (error, _stream) => {
        logger.error(JSON.stringify(error, null, 2));
      },
    );
  } catch (error) {
    logger.error(
      JSON.stringify({
        message: (error as Error).message,
        stack: (error as Error).stack,
        name: (error as Error).name,
      }),
    );
    return c.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      500,
    );
  }
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
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Model not found",
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

export function registerAnthropicRoutes(app: OpenAPIHono) {
  // POST /v1/messages - Anthropic-compatible messages endpoint
  app.openapi(messagesRoute, honoHandleMessages);
}
