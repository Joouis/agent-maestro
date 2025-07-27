import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import { ErrorResponseSchema } from "../schemas";
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
                model: "claude-opus-4-20250514",
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

// Anthropic Message Create Schema based on Anthropic.Messages.MessageCreateParams interface
const AnthropicMessageCreateParamsSchema = z.object({
  model: z.string().describe("The model to use for the request"),
  messages: z
    .array(
      z
        .object({
          role: z
            .enum(["user", "assistant"])
            .describe("The role of the message sender"),
          content: z
            .union([
              z.string(),
              z.array(
                z.union([
                  z.object({
                    type: z.literal("text"),
                    text: z.string(),
                  }),
                  z.object({
                    type: z.literal("image"),
                    source: z.object({
                      type: z.literal("base64"),
                      media_type: z.string(),
                      data: z.string(),
                    }),
                  }),
                  z.object({
                    type: z.literal("tool_use"),
                    id: z.string(),
                    name: z.string(),
                    input: z.record(z.string(), z.any()),
                  }),
                  z.object({
                    type: z.literal("tool_result"),
                    tool_use_id: z.string(),
                    content: z.union([z.string(), z.array(z.any())]).optional(),
                    is_error: z.boolean().optional(),
                  }),
                ]),
              ),
            ])
            .describe("The content of the message"),
        })
        .loose(),
    )
    .describe("Array of conversation messages"),
  system: z
    .union([
      z.string(),
      z.array(
        z
          .object({
            type: z.literal("text"),
            text: z.string(),
            cache_control: z
              .object({
                type: z.literal("ephemeral"),
              })
              .optional(),
          })
          .loose(),
      ),
    ])
    .optional()
    .describe("System message to guide the assistant"),
  max_tokens: z
    .number()
    .min(1)
    .optional()
    .describe("Maximum number of tokens to generate"),
  metadata: z
    .object({
      user_id: z.string().optional(),
    })
    .loose()
    .optional()
    .describe("Metadata for the request"),
  stop_sequences: z
    .array(z.string())
    .optional()
    .describe(
      "Custom text sequences that will cause the model to stop generating",
    ),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Controls randomness in responses (0.0 to 1.0)"),
  top_k: z
    .number()
    .min(1)
    .optional()
    .describe("Only sample from the top K options for each subsequent token"),
  top_p: z.number().min(0).max(1).optional().describe("Use nucleus sampling"),
  stream: z.boolean().optional().describe("Whether to stream the response"),
  tools: z
    .array(
      z.object({
        name: z.string().describe("The name of the tool"),
        description: z
          .string()
          .optional()
          .describe("Description of what the tool does"),
        input_schema: z
          .record(z.string(), z.any())
          .describe("JSON schema for the tool input"),
        cache_control: z
          .object({
            type: z.literal("ephemeral"),
          })
          .loose()
          .optional(),
      }),
    )
    .optional()
    .describe("Available tools for the model"),
  tool_choice: z
    .union([
      z.object({
        type: z.literal("auto"),
      }),
      z.object({
        type: z.literal("any"),
      }),
      z.object({
        type: z.literal("tool"),
        name: z.string(),
      }),
    ])
    .optional()
    .describe("Tool choice configuration"),
});

const AnthropicMessageResponseSchema = z
  .object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    model: z.string(),
    content: z.array(z.any()),
    stop_reason: z.string().nullable(),
    stop_sequence: z.string().nullable(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z.any().nullable(),
      service_tier: z.string().nullable(),
    }),
  })
  .loose();

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
