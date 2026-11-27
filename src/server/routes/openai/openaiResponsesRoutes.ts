import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import {
  ResponseCustomToolCall,
  ResponseUsage,
  Responses,
} from "openai/resources/responses/responses";
import * as vscode from "vscode";

import {
  getChatModelClient,
  getCopilotModelConfiguration,
  withCopilotConfiguration,
  withCopilotConversationId,
} from "../../../utils/chatModels";
import { logger } from "../../../utils/logger";
import { CommonResponseError } from "../../schemas/openai";
import { handleErrorWithLogging } from "../../utils/errorDiagnostics";
import { sendLanguageModelRequest } from "../../utils/languageModelRequest";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  LanguageModelRequestTimeoutError,
  interruptibleLanguageModelStream,
} from "../../utils/languageModelRequestLifecycle";
import {
  encryptedThinkingOptions,
  isThinkingPart,
} from "../../utils/languageModelThinking";
import { extractOpenAIResponsesUsage } from "../../utils/openai";
import {
  OpenAIResponsesStatus,
  OutputItem,
  PlaintextResponseFunctionToolCall,
  ProviderReasoningError,
  ReasoningItems,
  ResponseSSEWriter,
  ResponsesModelPart,
  ResponsesReasoningError,
  ResponsesToolSearchError,
  buildOpenAIResponsesEnvelope,
  buildResponseOutputFromParts,
  buildToolSearchCall,
  closeMessageOutputItem,
  convertResponsesInputToVSCode,
  customToolCallInput,
  extractAdditionalTools,
  generateCustomToolCallId,
  generateFunctionCallId,
  generateMessageId,
  generateResponseId,
  getCurrentTimestamp,
  openMessageOutputItem,
  plaintextFunctionCallMetadata,
  thinkingToResponseReasoning,
  withOpenAIResponsesHeartbeat,
  writeCustomToolCallOutputItem,
  writeFunctionToolCallOutputItem,
  writeMessageOutputTextDelta,
  writeReasoningOutputItem,
  writeToolSearchCallOutputItem,
} from "../../utils/openaiResponses";
import {
  OpenAIResponsesRequestValidationError,
  prepareOpenAIResponsesTools,
} from "../../utils/openaiResponsesWebSearch";
import {
  WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  WebSearchProvider,
} from "../../webSearch/webSearchProvider";
import { handleOpenAIResponsesWebSearch } from "./openaiResponsesWebSearchHandler";

type NonStreamingResponse = Omit<
  OpenAI.Responses.Response,
  | "output_text"
  | "instructions"
  | "tool_choice"
  | "tools"
  | "parallel_tool_calls"
  | "temperature"
  | "top_p"
>;

type OpenAIResponsesCreateParams = Responses.ResponseCreateParams & {
  max_tool_calls?: number | null;
};

// OpenAPI route definition for /v1/responses
const createResponseRoute = createRoute({
  method: "post",
  path: "/v1/responses",
  tags: ["OpenAI API"],
  summary: "Create a model response with OpenAI Responses API",
  description: `Create a model response using the OpenAI Responses API interface, powered by VSCode Language Models.

Limitations:
- Stateless: previous_response_id, conversation, item_reference not supported (send full history in input array)
- Tools: function, custom, namespace, additional_tools, and stable web_search are supported; file_search, code_interpreter, mcp, etc. are ignored
- Images: only base64 data URI supported (URL-based images fall back to JSON)
- input_file: not supported (serialized as JSON text)
- URL citations are synthesized from normalized web search results; other annotations are empty
- Reasoning: encrypted state is replayed when the host exposes compatible thinking constructors`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object()
            .describe(
              "OpenAI Responses API request body. See https://platform.openai.com/docs/api-reference/responses/create",
            ),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object()
            .describe(
              "OpenAI Responses API response. See https://platform.openai.com/docs/api-reference/responses/object",
            ),
        },
        "text/event-stream": {
          schema: z
            .object()
            .describe(
              "OpenAI Responses API streaming events. See https://platform.openai.com/docs/api-reference/responses/object",
            ),
        },
      },
      description: "Successfully created response",
    },
    400: {
      content: {
        "application/json": {
          schema: CommonResponseError,
        },
      },
      description: "Bad request - invalid or unsupported parameters",
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
    504: {
      content: {
        "application/json": {
          schema: CommonResponseError,
        },
      },
      description:
        "Gateway timeout - language model request exceeded 10 minutes",
    },
  },
});

export interface OpenaiResponsesRoutesOptions {
  heartbeatIntervalMs?: number;
  providerTimeoutMs?: number;
  requestTimeoutMs?: number;
  resolveChatModelClient?: typeof getChatModelClient;
  webSearchProvider?: WebSearchProvider;
}

export function registerOpenaiResponsesRoutes(
  app: OpenAPIHono,
  options: OpenaiResponsesRoutesOptions = {},
) {
  const resolveChatModelClient =
    options.resolveChatModelClient ?? getChatModelClient;
  const providerTimeoutMs =
    options.providerTimeoutMs ?? WEB_SEARCH_PROVIDER_TIMEOUT_MS;
  app.openapi(createResponseRoute, async (c: Context): Promise<Response> => {
    let rawRequestBody: OpenAIResponsesCreateParams | undefined;
    let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
    let requestedModelId = "";
    let inputTokens = 0;
    let requestLifecycle: LanguageModelRequestLifecycle | undefined;

    try {
      // 1. Parse request and extract fields
      const requestBody = (await c.req.json()) as OpenAIResponsesCreateParams;
      rawRequestBody = requestBody;

      const {
        model,
        input,
        instructions,
        stream = false,
        tools,
        tool_choice,
        metadata = {},
        // Stateful params (rejected below)
        previous_response_id,
        conversation,
        // OpenAI infrastructure features not applicable to VSCode LM
        store: _store,
        include,
        background: _background,
        prompt: _prompt,
        prompt_cache_key: promptCacheKey,
        service_tier: _serviceTier,
        user: _user,
        safety_identifier: _safetyId,
        reasoning: responseReasoning,
        max_output_tokens,
        max_tool_calls,
        parallel_tool_calls,
        // Remaining params passed through as modelOptions
        ...otherParams
      } = requestBody;

      requestedModelId = model ?? "";

      const modelOptions = withCopilotConversationId(
        otherParams as Record<string, unknown>,
        promptCacheKey,
      );
      if (max_output_tokens !== null && max_output_tokens !== undefined) {
        modelOptions.maxTokens = max_output_tokens;
      }

      // 2. Validate unsupported stateful parameters
      if (previous_response_id) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "previous_response_id is not supported. Agent Maestro is stateless. Please send full conversation history in the input array.",
              param: "previous_response_id",
              code: "unsupported_parameter",
            },
          },
          400,
        );
      }

      if (conversation) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "conversation parameter is not supported. Agent Maestro is stateless. Please send full conversation history in the input array.",
              param: "conversation",
              code: "unsupported_parameter",
            },
          },
          400,
        );
      }

      // 3. Validate required fields
      if (!model) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "model is required",
              param: "model",
              code: "missing_required_parameter",
            },
          },
          400,
        );
      }

      if (!input && !instructions) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Either input or instructions is required",
              param: "input",
              code: "missing_required_parameter",
            },
          },
          400,
        );
      }

      const effectiveTools = [
        ...(tools ?? []),
        ...extractAdditionalTools(input, tools),
      ];
      const preparedTools = prepareOpenAIResponsesTools({
        tools: effectiveTools,
        toolChoice: tool_choice,
        input,
        include,
        maxOutputTokens: max_output_tokens,
        maxToolCalls: max_tool_calls,
        parallelToolCalls: parallel_tool_calls,
        serverWebSearchAvailable: options.webSearchProvider !== undefined,
      });
      if (!preparedTools.usesWebSearchLoop) {
        if (max_tool_calls !== null && max_tool_calls !== undefined) {
          modelOptions.max_tool_calls = max_tool_calls;
        }
        if (parallel_tool_calls !== null && parallel_tool_calls !== undefined) {
          modelOptions.parallel_tool_calls = parallel_tool_calls;
        }
      }

      // 4. Get chat model client
      const { client: initialClient, error: clientError } =
        await resolveChatModelClient(model);

      if (clientError) {
        return c.json(clientError, 404);
      }
      let client = initialClient!;

      logger.debug("/v1/responses payload:");
      logger.debug(JSON.stringify(requestBody, null, 2));
      requestLifecycle = new LanguageModelRequestLifecycle(
        c.req.raw.signal,
        options.requestTimeoutMs,
      );
      const cancellationToken = requestLifecycle.token;

      logger.info(
        `→ /v1/responses | model: ${
          model === client.id ? model : `${model} → ${client.id}`
        }`,
      );

      // 6. Convert input to VSCode messages
      const vsCodeMessages = convertResponsesInputToVSCode(input, instructions);
      lmChatMessages = vsCodeMessages;

      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        ...encryptedThinkingOptions(),
        justification:
          "OpenAI Responses API endpoint using VS Code Language Model API",
        modelOptions,
        tools: preparedTools.tools,
        toolMode: preparedTools.toolMode,
      };
      const copilotConfiguration = getCopilotModelConfiguration({
        reasoningEffort: responseReasoning?.effort,
      });
      const configuredRequestOptions = withCopilotConfiguration(
        client,
        lmRequestOptions,
        copilotConfiguration,
      );

      if (preparedTools.usesWebSearchLoop) {
        return await handleOpenAIResponsesWebSearch({
          c,
          client,
          heartbeatIntervalMs: options.heartbeatIntervalMs,
          lifecycle: requestLifecycle,
          maxOutputTokens:
            typeof max_output_tokens === "number"
              ? max_output_tokens
              : undefined,
          messages: vsCodeMessages,
          metadata,
          model: client.id,
          parallelToolCalls: parallel_tool_calls,
          preparedTools,
          provider: options.webSearchProvider!,
          providerTimeoutMs,
          publicTools: tools ?? [],
          requestOptions: configuredRequestOptions,
          stream,
          toolChoice: tool_choice,
        });
      }

      // 9. Handle non-streaming response
      if (!stream) {
        const sent = await sendLanguageModelRequest({
          client,
          messages: vsCodeMessages,
          options: lmRequestOptions,
          copilotConfiguration,
          lifecycle: requestLifecycle,
          resolve: resolveChatModelClient,
        });
        const response = sent.response;
        client = sent.client;
        let accumulatedText = "";
        const toolCalls: { callId: string; name: string; input: unknown }[] =
          [];
        const parts: ResponsesModelPart[] = [];
        let responseUsage: ResponseUsage | undefined;

        for await (const chunk of interruptibleLanguageModelStream(
          response.stream,
          requestLifecycle,
        )) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            accumulatedText += chunk.value;
            parts.push(chunk);
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            parts.push(chunk);
            toolCalls.push({
              callId: chunk.callId,
              name: chunk.name,
              input: chunk.input,
            });
          } else if (isThinkingPart(chunk)) {
            parts.push(chunk);
          } else if (chunk instanceof vscode.LanguageModelDataPart) {
            responseUsage = extractOpenAIResponsesUsage(chunk) ?? responseUsage;
          }
        }

        // Build output
        const output = buildResponseOutputFromParts(
          parts,
          preparedTools.toolMap,
        );

        if (!responseUsage) {
          const [fallbackInputTokens, outputTokens] =
            await requestLifecycle.waitFor(
              Promise.all([
                client.countTokens(
                  JSON.stringify(requestBody),
                  cancellationToken,
                ),
                client.countTokens(
                  accumulatedText + JSON.stringify(toolCalls),
                  cancellationToken,
                ),
              ]),
            );
          inputTokens = fallbackInputTokens;
          responseUsage = {
            input_tokens: fallbackInputTokens,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: fallbackInputTokens + outputTokens,
          };
        }

        // Build response
        const responseObj: NonStreamingResponse = {
          id: generateResponseId(),
          object: "response",
          status: "completed",
          created_at: getCurrentTimestamp(),
          model: client.id,
          output,
          error: null,
          incomplete_details: null,
          usage: responseUsage,
          metadata,
        };

        logger.debug("/v1/responses response:");
        logger.debug(JSON.stringify(responseObj, null, 2));
        logger.info(
          `← /v1/responses | input: ${responseUsage?.input_tokens} | cache_read: ${responseUsage?.input_tokens_details?.cached_tokens} | output: ${responseUsage?.output_tokens}`,
        );

        requestLifecycle.dispose();
        return c.json(responseObj);
      }

      // 10. Handle streaming response
      const responseId = generateResponseId();
      const createdAt = getCurrentTimestamp();
      const sequenceNumberRef = { value: 0 };
      return streamSSE(
        c,
        async (sseStream) => {
          const writeSSE: ResponseSSEWriter = (message) =>
            requestLifecycle!.waitFor(sseStream.writeSSE(message));

          const buildResponseEnvelope = (
            status: OpenAIResponsesStatus,
            output: OutputItem[],
            usage: ResponseUsage | null = null,
            completedAt: number | null = null,
          ) =>
            buildOpenAIResponsesEnvelope({
              id: responseId,
              createdAt,
              model: client.id,
              metadata,
              parallelToolCalls: parallel_tool_calls,
              toolChoice: tool_choice,
              tools: tools ?? [],
              status,
              output,
              usage,
              completedAt,
            });

          // Emit response.created
          await writeSSE({
            event: "response.created",
            data: JSON.stringify({
              type: "response.created",
              response: buildResponseEnvelope("in_progress", []),
              sequence_number: sequenceNumberRef.value++,
            }),
          });

          // Emit response.in_progress
          await writeSSE({
            event: "response.in_progress",
            data: JSON.stringify({
              type: "response.in_progress",
              response: buildResponseEnvelope("in_progress", []),
              sequence_number: sequenceNumberRef.value++,
            }),
          });

          const { output, responseUsage } = await withOpenAIResponsesHeartbeat(
            writeSSE,
            sequenceNumberRef,
            async (writeSSE) => {
              const sent = await sendLanguageModelRequest({
                client,
                messages: vsCodeMessages,
                options: lmRequestOptions,
                copilotConfiguration,
                lifecycle: requestLifecycle!,
                resolve: resolveChatModelClient,
              });
              const response = sent.response;
              client = sent.client;
              // Process stream
              const output: OutputItem[] = [];
              const reasoning = new ReasoningItems("provider");
              let outputIndex = 0;
              let contentIndex = 0;
              let currentMessageId: string | null = null;
              let accumulatedText = "";
              // Buffer whitespace before opening a new message so Copilot's
              // pre-tool spacer (" ") never becomes a standalone empty message.
              let pendingLeadingWhitespace = "";
              // Mirror JSON fallback when an entire response only emits whitespace
              // around thinking boundaries and produces no other output items.
              let fallbackWhitespace = "";
              // Defer closing an open message across thinking parts until the
              // next output arrives or the stream ends so `phase` is exact.
              let pendingThinkingBoundary = false;
              const pendingReasoningItems: Array<
                NonNullable<ReturnType<typeof thinkingToResponseReasoning>>
              > = [];
              let totalOutputText = ""; // Track all output for token counting
              let responseUsage: ResponseUsage | undefined;

              const flushPendingReasoning = async () => {
                while (pendingReasoningItems.length > 0) {
                  const reasoningItem = pendingReasoningItems.shift()!;
                  output.push(reasoningItem);
                  await writeReasoningOutputItem(
                    writeSSE,
                    reasoningItem,
                    outputIndex++,
                    sequenceNumberRef,
                  );
                }
              };

              const closeOpenMessage = async (
                phase: "commentary" | "final_answer",
              ) => {
                if (!currentMessageId) {
                  return;
                }
                const outputItem = await closeMessageOutputItem(
                  writeSSE,
                  currentMessageId,
                  outputIndex++,
                  contentIndex,
                  accumulatedText,
                  sequenceNumberRef,
                  { phase },
                );
                output.push(outputItem);
                currentMessageId = null;
                accumulatedText = "";
              };

              for await (const chunk of interruptibleLanguageModelStream(
                response.stream,
                requestLifecycle!,
              )) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                  if (!chunk.value) {
                    continue;
                  }
                  if (pendingThinkingBoundary) {
                    if (!chunk.value.trim()) {
                      pendingLeadingWhitespace += chunk.value;
                      continue;
                    }
                    await closeOpenMessage("commentary");
                    await flushPendingReasoning();
                    pendingThinkingBoundary = false;
                  } else if (!currentMessageId && !chunk.value.trim()) {
                    pendingLeadingWhitespace += chunk.value;
                    continue;
                  }

                  const delta = pendingLeadingWhitespace + chunk.value;
                  pendingLeadingWhitespace = "";
                  fallbackWhitespace = "";
                  if (!currentMessageId) {
                    await flushPendingReasoning();
                    currentMessageId = generateMessageId();
                    contentIndex = 0;
                    await openMessageOutputItem(
                      writeSSE,
                      currentMessageId,
                      outputIndex,
                      contentIndex,
                      sequenceNumberRef,
                    );
                  }

                  accumulatedText += delta;
                  totalOutputText += delta;
                  await writeMessageOutputTextDelta(
                    writeSSE,
                    currentMessageId,
                    outputIndex,
                    contentIndex,
                    delta,
                    sequenceNumberRef,
                  );
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                  // Drop any Copilot whitespace spacer right before tool calls.
                  pendingLeadingWhitespace = "";
                  fallbackWhitespace = "";
                  pendingThinkingBoundary = false;
                  await closeOpenMessage("commentary");
                  await flushPendingReasoning();

                  totalOutputText += JSON.stringify(chunk);

                  const toolInfo = preparedTools.toolMap.get(chunk.name);
                  const toolName = toolInfo?.name ?? chunk.name;
                  const toolNamespace = toolInfo?.namespace;

                  if (toolInfo?.isToolSearch) {
                    const item = buildToolSearchCall(chunk.callId, chunk.input);
                    output.push(item);
                    await writeToolSearchCallOutputItem(
                      writeSSE,
                      item,
                      outputIndex++,
                      sequenceNumberRef,
                    );
                    continue;
                  }

                  if (toolInfo?.isCustom) {
                    const ctcId = generateCustomToolCallId();
                    const callId = chunk.callId;
                    const inputStr = customToolCallInput(chunk.input);
                    const customItem: ResponseCustomToolCall = {
                      type: "custom_tool_call",
                      id: ctcId,
                      call_id: callId,
                      name: toolName,
                      input: inputStr,
                      ...(toolNamespace ? { namespace: toolNamespace } : {}),
                    };
                    output.push(customItem);
                    await writeCustomToolCallOutputItem(
                      writeSSE,
                      customItem,
                      outputIndex,
                      sequenceNumberRef,
                    );
                    outputIndex++;
                    continue;
                  }

                  const fcId = generateFunctionCallId();
                  const callId = chunk.callId;
                  const argsStr = JSON.stringify(chunk.input ?? {});
                  const functionItem: PlaintextResponseFunctionToolCall = {
                    type: "function_call",
                    id: fcId,
                    call_id: callId,
                    name: toolName,
                    arguments: argsStr,
                    status: "completed",
                    ...(toolNamespace ? { namespace: toolNamespace } : {}),
                    ...plaintextFunctionCallMetadata(toolInfo),
                  };
                  output.push(functionItem);
                  await writeFunctionToolCallOutputItem(
                    writeSSE,
                    functionItem,
                    outputIndex,
                    sequenceNumberRef,
                  );
                  outputIndex++;
                } else if (isThinkingPart(chunk)) {
                  if (pendingLeadingWhitespace) {
                    if (
                      !currentMessageId &&
                      output.length === 0 &&
                      !fallbackWhitespace
                    ) {
                      fallbackWhitespace = pendingLeadingWhitespace;
                    }
                    pendingLeadingWhitespace = "";
                  }
                  if (currentMessageId) {
                    pendingThinkingBoundary = true;
                  }
                  const item = thinkingToResponseReasoning(chunk);
                  if (
                    !item ||
                    !reasoning.accept(item.id, item.encrypted_content)
                  ) {
                    continue;
                  }
                  if (currentMessageId) {
                    pendingReasoningItems.push(item);
                  } else {
                    output.push(item);
                    await writeReasoningOutputItem(
                      writeSSE,
                      item,
                      outputIndex++,
                      sequenceNumberRef,
                    );
                  }
                } else if (chunk instanceof vscode.LanguageModelDataPart) {
                  responseUsage =
                    extractOpenAIResponsesUsage(chunk) ?? responseUsage;
                }
              }

              // Close any remaining message
              const trailingFallback =
                pendingLeadingWhitespace || fallbackWhitespace;
              if (currentMessageId) {
                await closeOpenMessage("final_answer");
              } else if (output.length === 0 && trailingFallback) {
                const whitespaceMessageId = generateMessageId();
                contentIndex = 0;
                await openMessageOutputItem(
                  writeSSE,
                  whitespaceMessageId,
                  outputIndex,
                  contentIndex,
                  sequenceNumberRef,
                );
                totalOutputText += trailingFallback;
                await writeMessageOutputTextDelta(
                  writeSSE,
                  whitespaceMessageId,
                  outputIndex,
                  contentIndex,
                  trailingFallback,
                  sequenceNumberRef,
                );
                const outputItem = await closeMessageOutputItem(
                  writeSSE,
                  whitespaceMessageId,
                  outputIndex++,
                  contentIndex,
                  trailingFallback,
                  sequenceNumberRef,
                  { phase: "final_answer" },
                );
                output.push(outputItem);
              }
              await flushPendingReasoning();

              if (!responseUsage) {
                const [fallbackInputTokens, outputTokens] =
                  await requestLifecycle!.waitFor(
                    Promise.all([
                      client.countTokens(
                        JSON.stringify(requestBody),
                        cancellationToken,
                      ),
                      client.countTokens(totalOutputText, cancellationToken),
                    ]),
                  );
                inputTokens = fallbackInputTokens;
                responseUsage = {
                  input_tokens: fallbackInputTokens,
                  input_tokens_details: {
                    cached_tokens: 0,
                    cache_write_tokens: 0,
                  },
                  output_tokens: outputTokens,
                  output_tokens_details: { reasoning_tokens: 0 },
                  total_tokens: fallbackInputTokens + outputTokens,
                };
              }

              return { output, responseUsage };
            },
            options.heartbeatIntervalMs,
          );

          // Emit response.completed
          await writeSSE({
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              response: buildResponseEnvelope(
                "completed",
                output,
                responseUsage,
                getCurrentTimestamp(),
              ),
              sequence_number: sequenceNumberRef.value++,
            }),
          });

          logger.info(
            `← /v1/responses (stream) | input: ${responseUsage?.input_tokens} | cache_read: ${responseUsage?.input_tokens_details?.cached_tokens} | cache_write: ${responseUsage?.input_tokens_details?.cache_write_tokens} | output: ${responseUsage?.output_tokens}`,
          );
          requestLifecycle?.dispose();
        },
        async (error, sseStream) => {
          if (error instanceof LanguageModelClientDisconnectedError) {
            logger.info("/v1/responses | client disconnected");
            requestLifecycle?.dispose();
            await sseStream.close();
            return;
          }

          logger.error("✕ /v1/responses (stream) |", error);

          try {
            await sseStream.writeSSE({
              event: "response.failed",
              data: JSON.stringify({
                type: "response.failed",
                sequence_number: sequenceNumberRef.value++,
                response: {
                  id: responseId,
                  object: "response",
                  status: "failed",
                  created_at: createdAt,
                  model: client.id,
                  output: [],
                  error: {
                    code:
                      error instanceof LanguageModelRequestTimeoutError
                        ? "request_timeout"
                        : error instanceof ProviderReasoningError
                          ? error.code
                          : "server_error",
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                  incomplete_details: null,
                  usage: null,
                  metadata,
                },
              }),
            });
          } finally {
            requestLifecycle?.dispose();
            await sseStream.close();
          }
        },
      );
    } catch (error) {
      requestLifecycle?.dispose();

      if (error instanceof ProviderReasoningError) {
        logger.error("Responses provider returned conflicting reasoning state");
        return c.json(
          {
            error: {
              type: "upstream_error",
              message: error.message,
              param: null,
              code: error.code,
            },
          },
          502,
        );
      }

      if (
        error instanceof OpenAIResponsesRequestValidationError ||
        error instanceof ResponsesReasoningError ||
        error instanceof ResponsesToolSearchError
      ) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: error.message,
              param: error.param,
              code: error.code,
            },
          },
          400,
        );
      }

      if (error instanceof LanguageModelRequestTimeoutError) {
        logger.error("✕ /v1/responses |", error);
        return c.json(
          {
            error: {
              type: "timeout_error",
              message: error.message,
              param: null,
              code: "request_timeout",
            },
          },
          504,
        );
      }

      if (error instanceof LanguageModelClientDisconnectedError) {
        logger.info("/v1/responses | client disconnected");
        return new Response(null, { status: 499 });
      }

      logger.error("✕ /v1/responses |", error);

      const logFilePath = await handleErrorWithLogging({
        requestBody: rawRequestBody,
        inputTokens,
        lmChatMessages,
        error,
        endpoint: "/api/openai/v1/responses",
        modelId: requestedModelId,
      });

      return c.json(
        {
          error: {
            type: "internal_error",
            message:
              error instanceof Error ? error.message : "Internal server error",
            param: null,
            code: null,
            log_file: logFilePath,
          },
        },
        500,
      );
    }
  });
}
