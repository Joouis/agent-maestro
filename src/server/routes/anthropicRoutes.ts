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
} from "../utils/anthropic";

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

    logger.info(JSON.stringify(c.req.header(), null, 2));
    logger.info(JSON.stringify(requestBody, null, 2));

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
    // const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [];

    // 3. Build VS Code Language Model request options
    const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
      justification:
        "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
      modelOptions: msgCreateParams,
      tools: (tools as Anthropic.Messages.Tool[] | undefined)?.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.input_schema,
      })),
      toolMode:
        tool_choice?.type === "auto"
          ? vscode.LanguageModelChatToolMode.Auto
          : tool_choice?.type === "any"
            ? vscode.LanguageModelChatToolMode.Required
            : undefined,
    };

    // 4. Send request to the VS Code LM API
    const response = await client.sendRequest(
      vsCodeLmMessages,
      lmRequestOptions,
      new vscode.CancellationTokenSource().token,
    );

    // 5. Non-streaming response: collect full text
    if (!msgCreateParams.stream) {
      let fullText = "";
      for await (const fragment of response.text) {
        fullText += fragment;
      }

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
          input_tokens: 1,
          output_tokens: 1,
          server_tool_use: null,
          service_tier: null,
        },
        // container: null,
      };

      return c.json(resp);
    }

    // 6. If streaming, pipe chunks as SSE
    logger.info("====================== STREAMING ======================");
    return streamSSE(
      c,
      async (stream) => {
        try {
          await stream.writeSSE({
            event: "message_start",
            data: JSON.stringify({
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
                  input_tokens: 1,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  output_tokens: 1,
                  service_tier: "standard",
                },
              },
            }),
          });

          let isTextBlockStarted = false;
          let isToolCallBlockStarted = false;

          for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
              logger.info(`Text: `, chunk);
              if (!isTextBlockStarted) {
                isTextBlockStarted = true;
                await stream.writeSSE({
                  event: "content_block_start",
                  data: JSON.stringify({
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  }),
                });
              } else {
                await stream.writeSSE({
                  event: "content_block_delta",
                  data: JSON.stringify({
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: chunk.value },
                  }),
                });
              }
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              logger.info(`Tool call: `, chunk);
              if (!isToolCallBlockStarted) {
                isToolCallBlockStarted = true;
                await stream.writeSSE({
                  event: "content_block_start",
                  data: JSON.stringify({
                    type: "content_block_start",
                    index: 0,
                    content_block: {
                      type: "tool_use",
                      id: chunk.callId,
                      name: chunk.name,
                      input: chunk.input,
                    },
                  }),
                });
              }
              // await stream.writeSSE({
              //   event: "content_block_delta",
              //   data: JSON.stringify({
              //     type: "content_block_delta",
              //     index: 0,
              //     delta: { type: "input_json_delta", partial_json: chunk.input },
              //   }),
              // });
            }
          }

          await stream.writeSSE({
            event: "content_block_stop",
            data: JSON.stringify({ type: "content_block_stop", index: 0 }),
          });
          await stream.writeSSE({
            event: "message_delta",
            data: JSON.stringify({
              type: "message_delta",
              delta: {
                stop_reason: isToolCallBlockStarted ? "tool_use" : "end_turn",
                stop_sequence: null,
              },
              usage: { output_tokens: 1 },
            }),
          });
          await stream.writeSSE({
            event: "message_stop",
            data: JSON.stringify({ type: "message_stop" }),
          });

          // Signal end of stream
          logger.info("Streaming response completed");
        } catch (streamError) {
          logger.error("Error in streaming:", streamError);
        }
      },
      async (error, stream) => {
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
