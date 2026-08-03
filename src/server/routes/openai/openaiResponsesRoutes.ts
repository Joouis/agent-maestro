import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { ResponseUsage, Responses } from "openai/resources/responses/responses";
import * as vscode from "vscode";

import {
  getChatModelClient,
  getCopilotModelConfiguration,
  isGpt5PlusModel,
  withCopilotConfiguration,
} from "../../../utils/chatModels";
import { readConfiguration } from "../../../utils/config";
import {
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER,
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
} from "../../../utils/copilotWebSearchConstants";
import { logger } from "../../../utils/logger";
import { CommonResponseError } from "../../schemas/openai";
import { handleErrorWithLogging } from "../../utils/errorDiagnostics";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  LanguageModelRequestTimeoutError,
  interruptibleLanguageModelStream,
} from "../../utils/languageModelRequestLifecycle";
import { extractOpenAIResponsesUsage } from "../../utils/openai";
import {
  OutputItem,
  ResponseTool,
  ToolChoice,
  buildResponseOutput,
  closeMessageOutputItem,
  convertResponsesInputToVSCode,
  convertResponsesToolsToVSCode,
  convertToolChoice,
  customToolCallInput,
  extractAdditionalTools,
  generateCustomToolCallId,
  generateFunctionCallId,
  generateMessageId,
  generateResponseId,
  getCurrentTimestamp,
  getResponsesWebSearchTool,
  narrowToolsForChoice,
} from "../../utils/openaiResponses";

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

// OpenAPI route definition for /v1/responses
const createResponseRoute = createRoute({
  method: "post",
  path: "/v1/responses",
  tags: ["OpenAI API"],
  summary: "Create a model response with OpenAI Responses API",
  description: `Create a model response using the OpenAI Responses API interface, powered by VSCode Language Models.

Limitations:
- Stateless: previous_response_id, conversation, item_reference not supported (send full history in input array)
- Tools: function, custom, namespace, and additional_tools are supported; web_search tools can be passed through when the experimental GPT-5+ patch is enabled; file_search, code_interpreter, mcp, etc. are ignored
- Images: only base64 data URI supported (URL-based images fall back to JSON)
- input_file: not supported (serialized as JSON text)
- Annotations: always empty (VSCode LM doesn't provide annotations)
- Reasoning: not generated (VSCode LM doesn't expose reasoning tokens)`,
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
  requestTimeoutMs?: number;
  resolveChatModelClient?: typeof getChatModelClient;
}

export function registerOpenaiResponsesRoutes(
  app: OpenAPIHono,
  options: OpenaiResponsesRoutesOptions = {},
) {
  const resolveChatModelClient =
    options.resolveChatModelClient ?? getChatModelClient;
  app.openapi(createResponseRoute, async (c: Context): Promise<Response> => {
    let rawRequestBody: Responses.ResponseCreateParams | undefined;
    let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
    let requestedModelId = "";
    let inputTokens = 0;
    let requestLifecycle: LanguageModelRequestLifecycle | undefined;

    try {
      // 1. Parse request and extract fields
      const requestBody =
        (await c.req.json()) as Responses.ResponseCreateParams;
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
        include: _include,
        background: _background,
        prompt: _prompt,
        // Copilot manages prompt caching internally instead of using prompt_cache_key
        prompt_cache_key: _cacheKey,
        service_tier: _serviceTier,
        user: _user,
        safety_identifier: _safetyId,
        reasoning: responseReasoning,
        // Remaining params passed through as modelOptions
        ...otherParams
      } = requestBody;

      requestedModelId = model ?? "";

      // Rename max_output_tokens to maxTokens for VSCode LM compatibility
      const modelOptions = otherParams as Record<string, unknown>;
      if ("max_output_tokens" in modelOptions) {
        modelOptions.maxTokens = modelOptions.max_output_tokens;
        delete modelOptions.max_output_tokens;
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

      // 4. Get chat model client
      const { client, error: clientError } =
        await resolveChatModelClient(model);

      if (clientError) {
        return c.json(clientError, 404);
      }

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

      // 7. Build request options
      // Tools may arrive both at the top level and as `additional_tools`
      // items injected mid-conversation; merge both sources.
      const effectiveTools = [
        ...(tools ?? []),
        ...extractAdditionalTools(input),
      ];
      const webSearchTool = getResponsesWebSearchTool(effectiveTools);
      const experimentalWebSearchEnabled = webSearchTool
        ? readConfiguration().experimentalGpt5PlusWebSearchEnabled
        : false;
      const gpt5Plus = webSearchTool ? isGpt5PlusModel(model, client) : false;
      const shouldUseExperimentalWebSearch =
        !!webSearchTool && experimentalWebSearchEnabled && gpt5Plus;

      if (webSearchTool) {
        logger.debug(
          `Experimental GPT-5+ web search: enabled=${experimentalWebSearchEnabled}, gpt5Plus=${gpt5Plus}, toolType=${webSearchTool.type}, injected=${shouldUseExperimentalWebSearch}`,
        );
      }

      if (shouldUseExperimentalWebSearch) {
        const sentinelTool: ResponseTool = {
          type: "function",
          name: AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
          description:
            "Internal Agent Maestro marker for Copilot bundle web search patching.",
          strict: false,
          parameters: {
            type: "object",
            properties: {
              [AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER]: {
                const: webSearchTool,
              },
            },
          },
        };
        effectiveTools.push(sentinelTool);
      }

      const { tools: vsCodeTools, toolMap } = convertResponsesToolsToVSCode(
        effectiveTools,
        {
          webSearchHandledByCopilotPatch: shouldUseExperimentalWebSearch,
        },
      );
      const shouldPassTools =
        tool_choice !== "none" && effectiveTools.length > 0;

      let narrowedTools = vsCodeTools;
      if (shouldPassTools) {
        const narrowed = narrowToolsForChoice(
          tool_choice as ToolChoice,
          vsCodeTools,
          toolMap,
        );
        if (!narrowed.ok) {
          return c.json(
            {
              error: {
                type: "invalid_request_error",
                message:
                  `tool_choice named "${narrowed.targetName}" matched ` +
                  `${narrowed.matchCount} tools. A named tool_choice must ` +
                  "resolve to exactly one available tool.",
                param: "tool_choice",
                code:
                  narrowed.matchCount === 0
                    ? "tool_not_found"
                    : "ambiguous_tool_choice",
              },
            },
            400,
          );
        }
        narrowedTools = narrowed.tools;
      }

      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "OpenAI Responses API endpoint using VS Code Language Model API",
        modelOptions,
        tools: shouldPassTools ? narrowedTools : undefined,
        toolMode: shouldPassTools
          ? convertToolChoice(tool_choice as ToolChoice)
          : undefined,
      };
      const copilotConfiguration = getCopilotModelConfiguration({
        reasoningEffort: responseReasoning?.effort,
      });

      // 8. Send request to VSCode LM
      const response = await requestLifecycle.waitFor(
        client.sendRequest(
          vsCodeMessages,
          withCopilotConfiguration(
            client,
            lmRequestOptions,
            copilotConfiguration,
          ),
          cancellationToken,
        ),
      );

      // 9. Handle non-streaming response
      if (!stream) {
        let accumulatedText = "";
        const toolCalls: { callId: string; name: string; input: unknown }[] =
          [];
        let responseUsage: ResponseUsage | undefined;

        for await (const chunk of interruptibleLanguageModelStream(
          response.stream,
          requestLifecycle,
        )) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            accumulatedText += chunk.value;
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
              callId: chunk.callId,
              name: chunk.name,
              input: chunk.input,
            });
          } else if (chunk instanceof vscode.LanguageModelDataPart) {
            responseUsage = extractOpenAIResponsesUsage(chunk) ?? responseUsage;
          }
        }

        // Build output
        const output = buildResponseOutput(accumulatedText, toolCalls, toolMap);

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
          model,
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
      return streamSSE(
        c,
        async (sseStream) => {
          const responseId = generateResponseId();
          const createdAt = getCurrentTimestamp();
          const sequenceNumberRef = { value: 0 };
          const writeSSE = (
            message: Parameters<typeof sseStream.writeSSE>[0],
          ) => requestLifecycle!.waitFor(sseStream.writeSSE(message));

          // Build base response object
          const baseResponse = {
            id: responseId,
            object: "response" as const,
            created_at: createdAt,
            model: model,
            error: null,
            incomplete_details: null,
            metadata,
          };

          // Build full response envelope (matching upstream format)
          const buildResponseEnvelope = (
            status: string,
            output: OutputItem[],
            usage?: ResponseUsage | null,
            completedAt?: number | null,
          ) => ({
            ...baseResponse,
            status,
            background: false,
            completed_at: completedAt ?? null,
            output,
            parallel_tool_calls: true,
            reasoning: { effort: "none", summary: null },
            tool_choice: tool_choice ?? "auto",
            tools: tools ?? [],
            usage: usage ?? null,
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

          // Process stream
          const output: OutputItem[] = [];
          let outputIndex = 0;
          let contentIndex = 0;
          let currentMessageId: string | null = null;
          let accumulatedText = "";
          let totalOutputText = ""; // Track all output for token counting
          let responseUsage: ResponseUsage | undefined;

          for await (const chunk of interruptibleLanguageModelStream(
            response.stream,
            requestLifecycle!,
          )) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
              if (!currentMessageId) {
                // Start new message output item
                currentMessageId = generateMessageId();
                contentIndex = 0;

                await writeSSE({
                  event: "response.output_item.added",
                  data: JSON.stringify({
                    type: "response.output_item.added",
                    output_index: outputIndex,
                    item: {
                      type: "message",
                      id: currentMessageId,
                      role: "assistant",
                      content: [],
                      status: "in_progress",
                    },
                    sequence_number: sequenceNumberRef.value++,
                  }),
                });

                await writeSSE({
                  event: "response.content_part.added",
                  data: JSON.stringify({
                    type: "response.content_part.added",
                    item_id: currentMessageId,
                    output_index: outputIndex,
                    content_index: contentIndex,
                    part: { type: "output_text", text: "", annotations: [] },
                    sequence_number: sequenceNumberRef.value++,
                  }),
                });
              }

              // Emit text delta
              accumulatedText += chunk.value;
              totalOutputText += chunk.value;
              await writeSSE({
                event: "response.output_text.delta",
                data: JSON.stringify({
                  type: "response.output_text.delta",
                  item_id: currentMessageId,
                  output_index: outputIndex,
                  content_index: contentIndex,
                  delta: chunk.value,
                  sequence_number: sequenceNumberRef.value++,
                }),
              });
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              // Close current message if open
              if (currentMessageId) {
                const outputItem = await closeMessageOutputItem(
                  writeSSE,
                  currentMessageId,
                  outputIndex,
                  contentIndex,
                  accumulatedText,
                  sequenceNumberRef,
                );
                output.push(outputItem);
                outputIndex++;
                currentMessageId = null;
                accumulatedText = "";
              }

              totalOutputText += JSON.stringify(chunk);

              const toolInfo = toolMap.get(chunk.name);
              const toolName = toolInfo?.name ?? chunk.name;
              const toolNamespace = toolInfo?.namespace;

              if (toolInfo?.isCustom) {
                // Emit custom tool call events (raw string input, no JSON args)
                const ctcId = generateCustomToolCallId();
                const callId = chunk.callId;
                const inputStr = customToolCallInput(chunk.input);

                await writeSSE({
                  event: "response.output_item.added",
                  data: JSON.stringify({
                    type: "response.output_item.added",
                    output_index: outputIndex,
                    item: {
                      type: "custom_tool_call",
                      id: ctcId,
                      call_id: callId,
                      name: toolName,
                      input: "",
                      ...(toolNamespace ? { namespace: toolNamespace } : {}),
                    },
                    sequence_number: sequenceNumberRef.value++,
                  }),
                });

                await writeSSE({
                  event: "response.custom_tool_call_input.delta",
                  data: JSON.stringify({
                    type: "response.custom_tool_call_input.delta",
                    item_id: ctcId,
                    output_index: outputIndex,
                    delta: inputStr,
                    sequence_number: sequenceNumberRef.value++,
                  }),
                });

                await writeSSE({
                  event: "response.custom_tool_call_input.done",
                  data: JSON.stringify({
                    type: "response.custom_tool_call_input.done",
                    item_id: ctcId,
                    output_index: outputIndex,
                    input: inputStr,
                    sequence_number: sequenceNumberRef.value++,
                  }),
                });

                output.push({
                  type: "custom_tool_call",
                  id: ctcId,
                  call_id: callId,
                  name: toolName,
                  input: inputStr,
                  ...(toolNamespace ? { namespace: toolNamespace } : {}),
                });

                await writeSSE({
                  event: "response.output_item.done",
                  data: JSON.stringify({
                    type: "response.output_item.done",
                    output_index: outputIndex,
                    item: output[outputIndex],
                    sequence_number: sequenceNumberRef.value++,
                  }),
                });

                outputIndex++;
                continue;
              }

              // Emit function call events
              const fcId = generateFunctionCallId();
              const callId = chunk.callId;
              const argsStr = JSON.stringify(chunk.input ?? {});

              await writeSSE({
                event: "response.output_item.added",
                data: JSON.stringify({
                  type: "response.output_item.added",
                  output_index: outputIndex,
                  item: {
                    type: "function_call",
                    id: fcId,
                    call_id: callId,
                    name: toolName,
                    arguments: "",
                    status: "in_progress",
                    ...(toolNamespace ? { namespace: toolNamespace } : {}),
                  },
                  sequence_number: sequenceNumberRef.value++,
                }),
              });

              await writeSSE({
                event: "response.function_call_arguments.delta",
                data: JSON.stringify({
                  type: "response.function_call_arguments.delta",
                  item_id: fcId,
                  output_index: outputIndex,
                  delta: argsStr,
                  sequence_number: sequenceNumberRef.value++,
                }),
              });

              await writeSSE({
                event: "response.function_call_arguments.done",
                data: JSON.stringify({
                  type: "response.function_call_arguments.done",
                  item_id: fcId,
                  output_index: outputIndex,
                  arguments: argsStr,
                  sequence_number: sequenceNumberRef.value++,
                }),
              });

              output.push({
                type: "function_call",
                id: fcId,
                call_id: callId,
                name: toolName,
                arguments: argsStr,
                status: "completed",
                ...(toolNamespace ? { namespace: toolNamespace } : {}),
              });

              await writeSSE({
                event: "response.output_item.done",
                data: JSON.stringify({
                  type: "response.output_item.done",
                  output_index: outputIndex,
                  item: output[outputIndex],
                  sequence_number: sequenceNumberRef.value++,
                }),
              });

              outputIndex++;
            } else if (chunk instanceof vscode.LanguageModelDataPart) {
              responseUsage =
                extractOpenAIResponsesUsage(chunk) ?? responseUsage;
            }
          }

          // Close any remaining message
          if (currentMessageId) {
            const outputItem = await closeMessageOutputItem(
              writeSSE,
              currentMessageId,
              outputIndex,
              contentIndex,
              accumulatedText,
              sequenceNumberRef,
            );
            output.push(outputItem);
            outputIndex++;
          }

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
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: outputTokens,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: fallbackInputTokens + outputTokens,
            };
          }

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

          const responseId = generateResponseId();
          const createdAt = getCurrentTimestamp();

          try {
            await sseStream.writeSSE({
              event: "response.failed",
              data: JSON.stringify({
                type: "response.failed",
                response: {
                  id: responseId,
                  object: "response",
                  status: "failed",
                  created_at: createdAt,
                  model: model,
                  output: [],
                  error: {
                    code:
                      error instanceof LanguageModelRequestTimeoutError
                        ? "request_timeout"
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
