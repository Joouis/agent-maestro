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
  getVSCodeLmToolsAsLmChatTools,
} from "../utils/anthropic";
import { handleErrorWithLogging } from "../utils/errorDiagnostics";

const prepareAnthropicMessages = async ({
  requestBody,
  client,
}: {
  requestBody: Anthropic.Messages.MessageCreateParams;
  client: vscode.LanguageModelChat;
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

/**
 * Resolve model ID by checking the anthropic-beta header for context window variants.
 *
 * Claude Code sends `model: "claude-opus-4-6"` in the body and signals the 1M context
 * variant via the `anthropic-beta` header (e.g. `context-1m-2025-08-07`). The VS Code
 * LM API exposes these as separate model IDs (e.g. `claude-opus-4.6-1m`), so we append
 * `-1m` to the model ID when the beta header is present to allow fuzzy matching to find
 * the correct variant.
 *
 * This function is idempotent with respect to the `-1m` suffix: if the model already
 * ends with `-1m`, it is returned unchanged.
 */
function resolveModelId(model: string, c: Context): string {
  const betaHeader = c.req.header("anthropic-beta");
  if (betaHeader && /\bcontext-1m\b/.test(betaHeader)) {
    // Avoid double-appending the 1M context suffix (e.g. "model-1m-1m").
    if (model.endsWith("-1m")) {
      return model;
    }
    const resolved = `${model}-1m`;
    logger.info(
      `Detected context-1m beta header, resolving model "${model}" → "${resolved}"`,
    );
    return resolved;
  }
  return model;
}

export function registerAnthropicRoutes(app: OpenAPIHono) {
  // POST /v1/messages - Anthropic-compatible messages endpoint
  app.openapi(messagesRoute, async (c: Context): Promise<Response> => {
    let effectiveModelId = "";
    let maxInputTokens = 0;
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
      const resolvedModel = resolveModelId(model, c);
      const { client, error: clientError } =
        await getChatModelClient(resolvedModel);

      if (client) {
        effectiveModelId = client.id;
        maxInputTokens = client.maxInputTokens;
      }

      if (clientError) {
        return c.json(clientError, 404);
      }

      // 3. Map Anthropic messages to VS Code LM API messages and count input tokens
      const { vsCodeLmMessages, inputTokenCount } =
        await prepareAnthropicMessages({
          requestBody,
          client,
        });
      lmChatMessages = vsCodeLmMessages;
      inputTokens = inputTokenCount.calibrated;

      logger.info(
        `→ /v1/messages | model: ${
          model === effectiveModelId ? model : `${model} → ${effectiveModelId}`
        } | input: ${inputTokenCount.original} → ${inputTokenCount.calibrated}`,
      );

      // 4. Build VS Code Language Model request options
      // Merge tools from the request with all registered VS Code LM tools (e.g. MCP tools)
      const requestTools = convertAnthropicToolToVSCode(tools) ?? [];
      const requestToolNames = new Set(requestTools.map((t) => t.name));
      const mcpTools = getVSCodeLmToolsAsLmChatTools().filter(
        (t) => !requestToolNames.has(t.name),
      );
      const mergedTools = [...requestTools, ...mcpTools];

      logger.info(
        `→ /v1/messages tools | request: ${requestTools.length} | mcp injected: ${mcpTools.length} | total: ${mergedTools.length}`,
      );

      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
        modelOptions: msgCreateParams,
        tools: mergedTools.length > 0 ? mergedTools : undefined,
        toolMode: convertAnthropicToolChoiceToVSCode(tool_choice),
      };

      // 5. Send request to the VS Code LM API, with agentic loop for MCP tool calls
      const mcpToolNames = new Set(mcpTools.map((t) => t.name));
      const cancellationTokenSource = new vscode.CancellationTokenSource();
      const cancellationToken = cancellationTokenSource.token;

      /**
       * Execute a single LM request and collect all content blocks from the stream.
       * Returns the content blocks and stop reason.
       */
      const runSingleRequest = async (
        msgs: vscode.LanguageModelChatMessage[],
      ) => {
        const resp = await client.sendRequest(
          msgs,
          lmRequestOptions,
          cancellationToken,
        );
        const content: Anthropic.Messages.ContentBlock[] = [];
        let accumulatedText = "";

        for await (const chunk of resp.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            let lastBlock = content.at(-1);
            if (!lastBlock || lastBlock.type !== "text") {
              lastBlock = { type: "text", text: "", citations: null };
              content.push(lastBlock);
            }
            (lastBlock as Anthropic.Messages.TextBlock).text += chunk.value;
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

        const stopReason: Anthropic.Messages.StopReason =
          content.at(-1)?.type === "tool_use" ? "tool_use" : "end_turn";
        return { content, accumulatedText, stopReason };
      };

      /**
       * Invoke a single MCP tool via VS Code LM API and return the result as text.
       */
      const invokeMcpTool = async (
        _toolCallId: string,
        toolName: string,
        toolInput: object,
      ): Promise<string> => {
        try {
          logger.info(`→ invoking MCP tool: ${toolName}`);
          const result = await vscode.lm.invokeTool(
            toolName,
            { input: toolInput, toolInvocationToken: undefined as any },
            cancellationToken,
          );
          const textParts = result.content
            .filter((p) => p instanceof vscode.LanguageModelTextPart)
            .map((p) => (p as vscode.LanguageModelTextPart).value)
            .join("");
          logger.info(
            `← MCP tool ${toolName} result length: ${textParts.length}`,
          );
          return textParts;
        } catch (err) {
          const msg = err instanceof Error ? err.message : JSON.stringify(err);
          logger.error(`✕ MCP tool ${toolName} failed: ${msg}`);
          return `Error invoking tool ${toolName}: ${msg}`;
        }
      };

      // 6. Non-streaming response with MCP agentic loop
      if (!msgCreateParams.stream) {
        let currentMessages = vsCodeLmMessages;
        let finalContent: Anthropic.Messages.ContentBlock[] = [];
        let totalAccumulatedText = "";
        const MAX_TOOL_ROUNDS = 10;

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const { content, accumulatedText, stopReason } =
            await runSingleRequest(currentMessages);
          totalAccumulatedText += accumulatedText;

          // Collect MCP tool calls in this round
          const mcpToolCalls = content.filter(
            (b) => b.type === "tool_use" && mcpToolNames.has(b.name),
          ) as Anthropic.Messages.ToolUseBlock[];

          if (mcpToolCalls.length === 0 || stopReason !== "tool_use") {
            // No MCP tool calls — return final response to Claude Code
            finalContent = content;
            break;
          }

          // Execute all MCP tool calls and build tool_result messages
          const assistantParts: (
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelToolCallPart
          )[] = content.map((b) => {
            if (b.type === "tool_use") {
              return new vscode.LanguageModelToolCallPart(
                b.id,
                b.name,
                b.input as object,
              );
            }
            return new vscode.LanguageModelTextPart(
              b.type === "text" ? b.text : JSON.stringify(b),
            );
          });
          currentMessages = [
            ...currentMessages,
            vscode.LanguageModelChatMessage.Assistant(assistantParts),
          ];

          const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
          for (const toolCall of mcpToolCalls) {
            const resultText = await invokeMcpTool(
              toolCall.id,
              toolCall.name,
              toolCall.input as object,
            );
            toolResultParts.push(
              new vscode.LanguageModelToolResultPart(toolCall.id, [
                new vscode.LanguageModelTextPart(resultText),
              ]),
            );
          }
          currentMessages = [
            ...currentMessages,
            vscode.LanguageModelChatMessage.User(toolResultParts),
          ];

          // If there are non-MCP tool calls, return this round's content to Claude Code
          const nonMcpToolCalls = content.filter(
            (b) => b.type === "tool_use" && !mcpToolNames.has(b.name),
          );
          if (nonMcpToolCalls.length > 0) {
            finalContent = content;
            break;
          }
        }

        // Count output tokens
        const outputTokenCount = totalAccumulatedText
          ? await countAnthropicMessageTokens(totalAccumulatedText, client)
          : { original: 1, calibrated: 1 };

        const finalStopReason: Anthropic.Messages.StopReason =
          finalContent.at(-1)?.type === "tool_use" ? "tool_use" : "end_turn";

        // https://docs.anthropic.com/en/api/messages#response-id
        const resp: Anthropic.Messages.Message = {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: finalContent,
          stop_reason: finalStopReason,
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

          // Agentic loop: silently handle MCP tool calls, stream the final round
          let streamMessages = vsCodeLmMessages;
          const MAX_STREAM_TOOL_ROUNDS = 10;

          for (let round = 0; round < MAX_STREAM_TOOL_ROUNDS; round++) {
            const resp = await client.sendRequest(
              streamMessages,
              lmRequestOptions,
              cancellationToken,
            );

            // Collect all chunks first to check for MCP tool calls
            const roundContent: Anthropic.Messages.ContentBlock[] = [];
            let roundAccumulatedText = "";
            const chunks: (
              | vscode.LanguageModelTextPart
              | vscode.LanguageModelToolCallPart
            )[] = [];

            for await (const chunk of resp.stream) {
              if (
                chunk instanceof vscode.LanguageModelTextPart ||
                chunk instanceof vscode.LanguageModelToolCallPart
              ) {
                chunks.push(chunk);
              }
            }

            for (const chunk of chunks) {
              if (chunk instanceof vscode.LanguageModelTextPart) {
                let lastBlock = roundContent.at(-1);
                if (!lastBlock || lastBlock.type !== "text") {
                  lastBlock = { type: "text", text: "", citations: null };
                  roundContent.push(lastBlock);
                }
                (lastBlock as Anthropic.Messages.TextBlock).text += chunk.value;
                roundAccumulatedText += chunk.value;
              } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                roundContent.push({
                  type: "tool_use",
                  id: chunk.callId,
                  name: chunk.name,
                  input: chunk.input,
                });
                roundAccumulatedText += JSON.stringify(chunk);
              }
            }

            const mcpToolCallsInRound = roundContent.filter(
              (b) => b.type === "tool_use" && mcpToolNames.has(b.name),
            ) as Anthropic.Messages.ToolUseBlock[];
            const nonMcpToolCallsInRound = roundContent.filter(
              (b) => b.type === "tool_use" && !mcpToolNames.has(b.name),
            );

            const hasMcpCalls = mcpToolCallsInRound.length > 0;
            const hasNonMcpCalls = nonMcpToolCallsInRound.length > 0;

            if (!hasMcpCalls || hasNonMcpCalls) {
              // Final round: stream content to Claude Code
              const contentBlocks: Anthropic.Messages.ContentBlock[] = [];
              let accumulatedText = "";

              for (const chunk of chunks) {
                const lastBlock = contentBlocks.at(-1);
                if (chunk instanceof vscode.LanguageModelTextPart) {
                  if (lastBlock && lastBlock.type !== "text") {
                    await writeSSE({
                      type: "content_block_stop",
                      index: contentBlocks.length - 1,
                    });
                  }
                  if (!lastBlock || lastBlock.type !== "text") {
                    contentBlocks.push({
                      type: "text",
                      text: "",
                      citations: null,
                    });
                    await writeSSE({
                      type: "content_block_start",
                      index: contentBlocks.length - 1,
                      content_block: {
                        type: "text",
                        text: "",
                        citations: null,
                      },
                    });
                  }
                  (contentBlocks.at(-1) as Anthropic.Messages.TextBlock).text +=
                    chunk.value;
                  await writeSSE({
                    type: "content_block_delta",
                    index: contentBlocks.length - 1,
                    delta: { type: "text_delta", text: chunk.value },
                  });
                  accumulatedText += chunk.value;
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
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

              await writeSSE({
                type: "content_block_stop",
                index: contentBlocks.length - 1,
              });

              const outputTokenCount = accumulatedText
                ? await countAnthropicMessageTokens(accumulatedText, client)
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
              break;
            }

            // MCP-only tool calls: execute silently and continue the loop
            const assistantParts: (
              | vscode.LanguageModelTextPart
              | vscode.LanguageModelToolCallPart
            )[] = roundContent.map((b) => {
              if (b.type === "tool_use") {
                return new vscode.LanguageModelToolCallPart(
                  b.id,
                  b.name,
                  b.input as object,
                );
              }
              return new vscode.LanguageModelTextPart(
                b.type === "text" ? b.text : JSON.stringify(b),
              );
            });
            streamMessages = [
              ...streamMessages,
              vscode.LanguageModelChatMessage.Assistant(assistantParts),
            ];

            const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
            for (const toolCall of mcpToolCallsInRound) {
              const resultText = await invokeMcpTool(
                toolCall.id,
                toolCall.name,
                toolCall.input as object,
              );
              toolResultParts.push(
                new vscode.LanguageModelToolResultPart(toolCall.id, [
                  new vscode.LanguageModelTextPart(resultText),
                ]),
              );
            }
            streamMessages = [
              ...streamMessages,
              vscode.LanguageModelChatMessage.User(toolResultParts),
            ];
          }
        },
        async (error, _stream) => {
          logger.error("✕ /v1/messages |", error);
        },
      );
    } catch (error) {
      logger.error("✕ /v1/messages |", error);

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

      const isContextWindowExceeded =
        errorMessage.includes(
          "unexpected `tool_use_id` found in `tool_result` blocks",
        ) &&
        maxInputTokens > 0 &&
        inputTokens > maxInputTokens;

      if (isContextWindowExceeded) {
        const model = rawRequestBody?.model ?? effectiveModelId;

        logger.warn(
          `⚠ /v1/messages | context window exceeded | input: ${inputTokens} > max: ${maxInputTokens}`,
        );

        vscode.window.showWarningMessage(
          "The model has reached its context window limit. Please use the /compact command to reduce the conversation history. You can adjust 'agent-maestro.anthropic.tokenCountScaleFactor' in settings to fine-tune token estimation.",
        );

        if (rawRequestBody?.stream) {
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
                    input_tokens: inputTokens,
                    output_tokens: 0,
                    cache_creation_input_tokens: null,
                    cache_read_input_tokens: null,
                    server_tool_use: null,
                    service_tier: "standard",
                  },
                },
              });

              await writeSSE({
                type: "message_delta",
                delta: {
                  stop_reason:
                    "model_context_window_exceeded" as Anthropic.Messages.StopReason,
                  stop_sequence: null,
                },
                usage: {
                  input_tokens: inputTokens * 2, // Inflate to ensure Claude Code triggers auto-compact before next message
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                  server_tool_use: null,
                },
              });

              await writeSSE({ type: "message_stop" });
            },
            async (err, _stream) => {
              logger.error(
                "✕ /v1/messages (context window exceeded stream) |",
                err,
              );
            },
          );
        }

        return c.json({
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason:
            "model_context_window_exceeded" as Anthropic.Messages.StopReason,
          stop_sequence: null,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            input_tokens: inputTokens * 2, // Inflate to ensure Claude Code triggers auto-compact before next message
            output_tokens: 0,
            server_tool_use: null,
            service_tier: null,
          },
        } as Anthropic.Messages.Message);
      }

      const isModelNotSupportedError = errorMessage.includes(
        "model_not_supported",
      );

      let hintMessage: string | undefined;

      if (isModelNotSupportedError) {
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

      const resolvedModel = resolveModelId(requestBody.model, c);
      const { client, error: clientError } =
        await getChatModelClient(resolvedModel);

      if (clientError) {
        return c.json(clientError, 404);
      }

      const { inputTokenCount } = await prepareAnthropicMessages({
        requestBody,
        client,
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
