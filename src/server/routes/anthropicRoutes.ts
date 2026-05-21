import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";

import { chatModelsCache, getChatModelClient } from "../../utils/chatModels";
import { resolveClaudeCodeModelId } from "../../utils/claude";
import { logger } from "../../utils/logger";
import { AnthropicErrorResponseSchema } from "../schemas/anthropic";
import {
  type AnthropicTokenUsage,
  OrphanToolResultError,
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
  countAnthropicMessageTokens,
  extractAnthropicTokenUsageFromVSCodeChunk,
  isDownstreamTruncationOrphan,
  isInputAtOrOverCapacity,
  validateAnthropicToolPairing,
} from "../utils/anthropic";
import {
  createAnthropicModelsResponse,
  findAnthropicModelById,
} from "../utils/anthropicModels";
import { handleErrorWithLogging } from "../utils/errorDiagnostics";
import { isResponseTooLongError } from "../utils/languageModelErrors";

const CONTEXT_WINDOW_WARNING_THROTTLE_MS = 15_000;
let lastContextWindowWarningAt = 0;

/**
 * Show the "context window exceeded — please /compact" toast at most once
 * per `CONTEXT_WINDOW_WARNING_THROTTLE_MS`. SDK clients (Claude Code SDK,
 * autonomous goals) auto-retry on `model_context_window_exceeded`, so the
 * downstream-truncation code path can fire many times per second; without
 * throttling, VS Code stacks identical notifications and drowns the editor.
 * The structured logger.warn at every occurrence is the source of truth for
 * frequency — this only governs the user-visible toast.
 */
const maybeShowContextWindowWarning = (): void => {
  const now = Date.now();
  if (now - lastContextWindowWarningAt < CONTEXT_WINDOW_WARNING_THROTTLE_MS) {
    return;
  }
  lastContextWindowWarningAt = now;
  void vscode.window.showWarningMessage(
    "The model has reached its context window limit. Please use the /compact command to reduce the conversation history. You can adjust 'agent-maestro.anthropic.tokenCountScaleFactor' in settings to fine-tune token estimation.",
  );
};

const prepareAnthropicMessages = async ({
  requestBody,
}: {
  requestBody: Anthropic.Messages.MessageCreateParams;
}) => {
  logger.debug("/v1/messages payload:");
  logger.debug(JSON.stringify(requestBody, null, 2));

  const { system, messages } = requestBody;

  const pairing = validateAnthropicToolPairing(messages ?? []);
  if (!pairing.ok) {
    throw new OrphanToolResultError(pairing.orphanIds);
  }

  const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
    ...convertAnthropicSystemToVSCode(system),
    ...convertAnthropicMessagesToVSCode(messages),
  ];

  const cancellationToken = new vscode.CancellationTokenSource().token;

  return {
    vsCodeLmMessages,
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

const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  tags: ["Anthropic API"],
  summary: "List Anthropic-compatible models",
  description:
    "List Claude models available through VS Code Language Models using an Anthropic-compatible response shape.",
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Anthropic Models API response body. See https://docs.anthropic.com/en/api/models-list for schema details.",
            ),
        },
      },
      description: "Successfully listed models",
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

const modelRoute = createRoute({
  method: "get",
  path: "/v1/models/{model_id}",
  tags: ["Anthropic API"],
  summary: "Retrieve an Anthropic-compatible model",
  description:
    "Retrieve one Claude model available through VS Code Language Models using an Anthropic-compatible response shape.",
  request: {
    params: z.object({
      model_id: z.string().describe("Model identifier"),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Anthropic Models API response body. See https://docs.anthropic.com/en/api/models-retrieve for schema details.",
            ),
        },
      },
      description: "Successfully retrieved model",
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
  // GET /v1/models - Anthropic-compatible models endpoint
  app.openapi(modelsRoute, async (c) => {
    try {
      logger.info("Fetching Anthropic-compatible models from VS Code LM API");
      const models = await chatModelsCache.getChatModels();
      const response = createAnthropicModelsResponse(models);
      logger.info(`Retrieved ${response.data.length} Anthropic models`);
      return c.json(response, 200);
    } catch (error) {
      logger.error("Error fetching Anthropic-compatible models:", error);
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Failed to fetch models",
            type: "api_error",
          },
        },
        500,
      );
    }
  });

  // GET /v1/models/{model_id} - Anthropic-compatible model retrieval endpoint
  app.openapi(modelRoute, async (c) => {
    const { model_id: modelId } = c.req.valid("param");

    try {
      logger.info(`Fetching Anthropic-compatible model: ${modelId}`);
      const models = await chatModelsCache.getChatModels();
      const model = findAnthropicModelById(models, modelId);

      if (!model) {
        return c.json(
          {
            error: {
              message: `Model '${modelId}' not found`,
              type: "not_found_error",
            },
          },
          404,
        );
      }

      return c.json(model, 200);
    } catch (error) {
      logger.error("Error fetching Anthropic-compatible model:", error);
      return c.json(
        {
          error: {
            message:
              error instanceof Error ? error.message : "Failed to fetch model",
            type: "api_error",
          },
        },
        500,
      );
    }
  });

  // POST /v1/messages - Anthropic-compatible messages endpoint
  app.openapi(messagesRoute, async (c: Context): Promise<Response> => {
    let effectiveModelId = "";
    let rawRequestBody;
    let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
    let inputTokens = 0;
    let maxInputTokens = 0;

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
      const resolvedModel = resolveClaudeCodeModelId(
        model,
        c.req.header("anthropic-beta"),
      );

      // 1. Get chat model client (handles model mapping internally)
      const { client: initialClient, error: clientError } =
        await getChatModelClient(resolvedModel);

      if (initialClient) {
        effectiveModelId = initialClient.id;
        maxInputTokens = initialClient.maxInputTokens;
      }

      if (clientError) {
        return c.json(clientError, 404);
      }

      let client = initialClient!;

      // 3. Map Anthropic messages to VS Code LM API messages
      const { vsCodeLmMessages, cancellationToken } =
        await prepareAnthropicMessages({
          requestBody: { ...requestBody, model: resolvedModel },
        });
      lmChatMessages = vsCodeLmMessages;
      const inputTokenCount = await countAnthropicMessageTokens(
        JSON.stringify(requestBody),
        client,
      );
      inputTokens = inputTokenCount.calibrated;
      logger.info(
        `→ /v1/messages | model: ${
          model === effectiveModelId ? model : `${model} → ${effectiveModelId}`
        } | input: ${inputTokenCount.original} → ${inputTokenCount.calibrated} | maxInput: ${maxInputTokens}`,
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

      const getFallbackUsage = async (
        accumulatedText: string,
      ): Promise<AnthropicTokenUsage> => {
        const outputTokenCount = accumulatedText
          ? await countAnthropicMessageTokens(accumulatedText, client)
          : { original: 1, calibrated: 1 };

        return {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: inputTokenCount.calibrated,
          output_tokens: outputTokenCount.calibrated,
        };
      };

      // 6. Non-streaming response: collect content blocks using unified approach
      if (!msgCreateParams.stream) {
        const content: Anthropic.Messages.ContentBlock[] = [];
        let accumulatedText = "";
        let responseUsage: AnthropicTokenUsage | undefined;
        let stopReason: Anthropic.Messages.StopReason = "end_turn";

        try {
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
                caller: { type: "direct" },
                name: chunk.name,
                input: chunk.input,
              });

              accumulatedText += JSON.stringify(chunk);
            } else if (chunk instanceof vscode.LanguageModelDataPart) {
              responseUsage =
                extractAnthropicTokenUsageFromVSCodeChunk(chunk) ??
                responseUsage;
            }
          }
        } catch (streamError) {
          if (!isResponseTooLongError(streamError)) {
            throw streamError;
          }

          stopReason = "max_tokens";
          logger.warn(
            `/v1/messages | returning truncated response after length error | contentBlocks: ${content.length}`,
          );
        }

        const usage =
          responseUsage ?? (await getFallbackUsage(accumulatedText));

        // https://docs.anthropic.com/en/api/messages#response-id
        const resp: Anthropic.Messages.Message = {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model,
          container: null,
          content,
          stop_details: null,
          stop_reason:
            stopReason === "max_tokens"
              ? "max_tokens"
              : content.at(-1)?.type === "tool_use"
                ? "tool_use"
                : "end_turn",
          stop_sequence: null,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            inference_geo: null,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            server_tool_use: null,
            service_tier: null,
          },
          // container: null,
        };

        logger.debug("/v1/messages response:");
        logger.debug(JSON.stringify(resp, null, 2));
        logger.info(
          `← /v1/messages | input: ${usage.input_tokens} | cache_read: ${usage.cache_read_input_tokens} | cache_creation: ${usage.cache_creation_input_tokens} | output: ${usage.output_tokens}`,
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
              container: null,
              content: [],
              stop_details: null,
              stop_reason: null,
              stop_sequence: null,
              usage: {
                cache_creation: null,
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                inference_geo: null,
                server_tool_use: null,
                service_tier: "standard",
              },
            },
          });

          const contentBlocks: Anthropic.Messages.ContentBlock[] = [];
          let accumulatedText = "";
          let responseUsage: AnthropicTokenUsage | undefined;
          let stopReason: Anthropic.Messages.StopReason = "end_turn";

          try {
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
                  caller: { type: "direct" },
                  name: chunk.name,
                  input: chunk.input,
                });

                await writeSSE({
                  type: "content_block_start",
                  index: contentBlocks.length - 1,
                  content_block: {
                    type: "tool_use",
                    id: chunk.callId,
                    caller: { type: "direct" },
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
              } else if (chunk instanceof vscode.LanguageModelDataPart) {
                responseUsage =
                  extractAnthropicTokenUsageFromVSCodeChunk(chunk) ??
                  responseUsage;
              }
            }
          } catch (streamError) {
            if (isResponseTooLongError(streamError)) {
              stopReason = "max_tokens";
              logger.warn(
                `/v1/messages (stream) | returning truncated response after length error | contentBlocks: ${contentBlocks.length}`,
              );
            } else {
              // Mid-stream orphan tool_use_id error: vscode.lm normally
              // surfaces orphan-pairing errors from `sendRequest()` (caught by
              // the outer try/catch around `streamSSE`), but if a future
              // version of Copilot ever defers validation until generation
              // begins, the error appears here instead — inside `streamSSE`,
              // where rethrowing would only land in `streamSSE`'s onError and
              // never reach the outer fallback. Apply the same case-1/case-2
              // disambiguation as the outer catch: only translate to
              // model_context_window_exceeded when calibrated input is at or
              // over capacity (true downstream truncation); otherwise rethrow
              // so a Copilot-side bug that happens to surface mid-stream
              // stays visible.
              const streamErrorMessage =
                streamError instanceof Error
                  ? streamError.message
                  : JSON.stringify(streamError);
              if (isDownstreamTruncationOrphan(streamErrorMessage)) {
                const errorCode = (streamError as { code?: unknown })?.code;
                logger.info(
                  `/v1/messages (stream) | orphan tool_use_id error caught mid-stream | error.code=${String(errorCode)} | error.constructor=${streamError?.constructor?.name ?? "n/a"}`,
                );
                if (isInputAtOrOverCapacity(inputTokens, maxInputTokens)) {
                  logger.warn(
                    `/v1/messages (stream) | context window exceeded (orphan tool_use_id from downstream, surfaced mid-stream) | input: ${inputTokens} / max: ${maxInputTokens}`,
                  );
                  maybeShowContextWindowWarning();
                  stopReason =
                    "model_context_window_exceeded" as Anthropic.Messages.StopReason;
                } else {
                  logger.warn(
                    `/v1/messages (stream) | orphan tool_use_id mid-stream but input under capacity (input: ${inputTokens} / max: ${maxInputTokens}) — likely Copilot bug, not capacity. Rethrowing.`,
                  );
                  throw streamError;
                }
              } else {
                throw streamError;
              }
            }
          }

          logger.debug("/v1/messages streamed content block responses:");
          logger.debug(JSON.stringify(contentBlocks, null, 2));

          // Finalize last content block if it exists
          if (contentBlocks.length > 0) {
            await writeSSE({
              type: "content_block_stop",
              index: contentBlocks.length - 1,
            });
          }

          const usage =
            responseUsage ?? (await getFallbackUsage(accumulatedText));

          await writeSSE({
            type: "message_delta",
            delta: {
              container: null,
              stop_details: null,
              stop_reason:
                stopReason === "max_tokens"
                  ? "max_tokens"
                  : stopReason ===
                      ("model_context_window_exceeded" as Anthropic.Messages.StopReason)
                    ? stopReason
                    : contentBlocks.at(-1)?.type === "tool_use"
                      ? "tool_use"
                      : "end_turn",
              stop_sequence: null,
            },
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
              server_tool_use: null,
            },
          });

          await writeSSE({ type: "message_stop" });

          logger.info(
            `← /v1/messages (stream) | input: ${usage.input_tokens} | cache_read: ${usage.cache_read_input_tokens} | cache_creation: ${usage.cache_creation_input_tokens} | output: ${usage.output_tokens}`,
          );
        },
        async (error, _stream) => {
          logger.error("✕ /v1/messages |", error);
        },
      );
    } catch (error) {
      logger.error("✕ /v1/messages |", error);

      const logFilePath = await handleErrorWithLogging({
        requestBody: rawRequestBody,
        lmChatMessages,
        error,
        endpoint: "/api/anthropic/v1/messages",
        modelId: effectiveModelId,
        inputTokens,
      });

      // The request itself contained tool_result blocks with no matching
      // tool_use. Refuse it with 400 — do NOT translate to context-window
      // exceeded, because compacting won't help (the client is malformed).
      // We return JSON even when the client asked for `stream: true`; this
      // matches the upstream Anthropic API, which refuses pre-stream
      // validation failures before opening any SSE channel. Do not call
      // streamSSE() above this point or that contract breaks.
      // Diagnostics are still captured (above) so client-side bugs can be
      // investigated from the same log file path as other failures.
      if (error instanceof OrphanToolResultError) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: error.message,
              log_file: logFilePath,
            },
          },
          400,
        );
      }

      const errorMessage =
        error instanceof Error ? error.message : JSON.stringify(error);

      if (isDownstreamTruncationOrphan(errorMessage)) {
        // Dogfood diagnostic: capture vscode.lm error.code and full error
        // shape so we can later confirm whether Copilot fills `code` with a
        // stable provider-specific value (in which case a future PR can
        // replace this message-substring match with a code match).
        // Documented as `Unknown` historically; logging here lets us verify
        // against current Copilot builds.
        const errorCode = (error as { code?: unknown })?.code;
        logger.info(
          `/v1/messages | orphan tool_use_id error caught | error.code=${String(errorCode)} | error.constructor=${error?.constructor?.name ?? "n/a"} | error.name=${(error as Error)?.name ?? "n/a"}`,
        );

        // Disambiguate the two known causes of this error:
        //   case 2 — calibrated input is at or over the model's max input
        //            capacity → Copilot's internal truncation almost certainly
        //            cut a tool_use/tool_result pair to keep the prompt under
        //            the cap. Translate to model_context_window_exceeded so
        //            Claude Code (incl. SDK and autonomous-goal callers) can
        //            auto-compact and retry.
        //   case 1 — capacity is well below the cap → orphan came from a
        //            Copilot-side bug (also seen in litellm). Translating
        //            here would mask the bug; rethrow so the underlying
        //            error stays visible to whoever owns the upstream fix.
        if (!isInputAtOrOverCapacity(inputTokens, maxInputTokens)) {
          logger.warn(
            `/v1/messages | orphan tool_use_id error but input under capacity (input: ${inputTokens} / max: ${maxInputTokens}) — likely Copilot bug, not capacity. Letting the original error surface.`,
          );
        } else {
          const model = rawRequestBody?.model ?? effectiveModelId;
          const modelLabel =
            model === effectiveModelId
              ? effectiveModelId
              : `${model} → ${effectiveModelId}`;

          logger.warn(
            `/v1/messages | context window exceeded (orphan tool_use_id from downstream) | input: ${inputTokens} / max: ${maxInputTokens} | model: ${modelLabel}`,
          );

          // SDK clients (Claude Code SDK, autonomous goals) retry on
          // `model_context_window_exceeded` automatically, so this branch can
          // fire many times in quick succession. Throttle the user-visible
          // toast so VS Code doesn't stack notifications; the structured log
          // line above still records every occurrence for debugging.
          maybeShowContextWindowWarning();

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
                    container: null,
                    content: [],
                    stop_details: null,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                      cache_creation: null,
                      input_tokens: inputTokens,
                      output_tokens: 0,
                      cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0,
                      inference_geo: null,
                      server_tool_use: null,
                      service_tier: "standard",
                    },
                  },
                });

                await writeSSE({
                  type: "message_delta",
                  delta: {
                    container: null,
                    stop_details: null,
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
            container: null,
            content: [],
            stop_details: null,
            stop_reason:
              "model_context_window_exceeded" as Anthropic.Messages.StopReason,
            stop_sequence: null,
            usage: {
              cache_creation: null,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              inference_geo: null,
              input_tokens: inputTokens * 2, // Inflate to ensure Claude Code triggers auto-compact before next message
              output_tokens: 0,
              server_tool_use: null,
              service_tier: null,
            },
          } as Anthropic.Messages.Message);
        }
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
      const resolvedModel = resolveClaudeCodeModelId(
        requestBody.model,
        c.req.header("anthropic-beta"),
      );
      const { client, error: clientError } =
        await getChatModelClient(resolvedModel);

      if (clientError) {
        return c.json(clientError, 404);
      }
      const inputTokenCount = await countAnthropicMessageTokens(
        JSON.stringify(requestBody),
        client,
      );

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
