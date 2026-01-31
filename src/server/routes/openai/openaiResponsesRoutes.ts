import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import OpenAI from "openai";
import { Responses } from "openai/resources/responses/responses";
import * as vscode from "vscode";

import { getChatModelClient } from "../../../utils/chatModels";
import { logger } from "../../../utils/logger";
import { CommonResponseError } from "../../schemas/openai";
import { handleErrorWithLogging } from "../../utils/errorDiagnostics";
import {
  OutputItem,
  ToolChoice,
  buildResponseOutput,
  closeMessageOutputItem,
  convertResponsesInputToVSCode,
  convertResponsesToolsToVSCode,
  convertToolChoice,
  generateFunctionCallId,
  generateMessageId,
  generateResponseId,
  getCurrentTimestamp,
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
- Only function tools supported (file_search, web_search, code_interpreter, custom, etc. are ignored)
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
  },
});

export function registerOpenaiResponsesRoutes(app: OpenAPIHono) {
  app.openapi(createResponseRoute, async (c: Context): Promise<Response> => {
    let rawRequestBody: Responses.ResponseCreateParams | undefined;
    let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
    let requestedModelId = "";
    let inputTokens = 0;

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
        prompt_cache_key: _cacheKey,
        service_tier: _serviceTier,
        user: _user,
        safety_identifier: _safetyId,
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
      const { client, error: clientError } = await getChatModelClient(model);

      if (clientError) {
        return c.json(clientError, 404);
      }

      // 5. Count input tokens
      const requestBodyStr = JSON.stringify(requestBody);
      logger.debug("/v1/responses payload:", requestBodyStr);
      const cancellationTokenSource = new vscode.CancellationTokenSource();
      const cancellationToken = cancellationTokenSource.token;
      inputTokens = await client.countTokens(requestBodyStr, cancellationToken);

      logger.info(
        `→ /v1/responses | model: ${
          model === client.id ? model : `${model} → ${client.id}`
        } | input: ${inputTokens}`,
      );

      // 6. Convert input to VSCode messages
      const vsCodeMessages = convertResponsesInputToVSCode(input, instructions);
      lmChatMessages = vsCodeMessages;

      // 7. Build request options
      const shouldPassTools =
        tool_choice !== "none" && tools && tools.length > 0;

      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "OpenAI Responses API endpoint using VS Code Language Model API",
        modelOptions,
        tools: shouldPassTools
          ? convertResponsesToolsToVSCode(tools)
          : undefined,
        toolMode: shouldPassTools
          ? convertToolChoice(tool_choice as ToolChoice)
          : undefined,
      };

      // 8. Send request to VSCode LM
      const response = await client.sendRequest(
        vsCodeMessages,
        lmRequestOptions,
        cancellationToken,
      );

      // 9. Handle non-streaming response
      if (!stream) {
        let accumulatedText = "";
        const toolCalls: { callId: string; name: string; input: unknown }[] =
          [];

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            accumulatedText += chunk.value;
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
              callId: chunk.callId,
              name: chunk.name,
              input: chunk.input,
            });
          }
        }

        // Build output
        const output = buildResponseOutput(accumulatedText, toolCalls);

        // Count output tokens
        const outputTokens = await client.countTokens(
          accumulatedText + JSON.stringify(toolCalls),
          cancellationToken,
        );

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
          usage: {
            input_tokens: inputTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: inputTokens + outputTokens,
          },
          metadata,
        };

        logger.debug(
          "/v1/responses response:",
          JSON.stringify(responseObj, null, 2),
        );
        logger.info(
          `← /v1/responses | input: ${inputTokens} | output: ${outputTokens}`,
        );

        cancellationTokenSource.dispose();
        return c.json(responseObj);
      }

      // 10. Handle streaming response
      return streamSSE(
        c,
        async (sseStream) => {
          const responseId = generateResponseId();
          const createdAt = getCurrentTimestamp();

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

          // Emit response.created
          await sseStream.writeSSE({
            event: "response.created",
            data: JSON.stringify({
              type: "response.created",
              response: {
                ...baseResponse,
                status: "in_progress",
                output: [],
              },
            }),
          });

          // Emit response.in_progress
          await sseStream.writeSSE({
            event: "response.in_progress",
            data: JSON.stringify({
              type: "response.in_progress",
              response: {
                ...baseResponse,
                status: "in_progress",
                output: [],
              },
            }),
          });

          // Process stream
          const output: OutputItem[] = [];
          let outputIndex = 0;
          let contentIndex = 0;
          let currentMessageId: string | null = null;
          let accumulatedText = "";
          let totalOutputText = ""; // Track all output for token counting

          for await (const chunk of response.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
              if (!currentMessageId) {
                // Start new message output item
                currentMessageId = generateMessageId();
                contentIndex = 0;

                await sseStream.writeSSE({
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
                  }),
                });

                await sseStream.writeSSE({
                  event: "response.content_part.added",
                  data: JSON.stringify({
                    type: "response.content_part.added",
                    item_id: currentMessageId,
                    output_index: outputIndex,
                    content_index: contentIndex,
                    part: { type: "output_text", text: "", annotations: [] },
                  }),
                });
              }

              // Emit text delta
              accumulatedText += chunk.value;
              totalOutputText += chunk.value;
              await sseStream.writeSSE({
                event: "response.output_text.delta",
                data: JSON.stringify({
                  type: "response.output_text.delta",
                  item_id: currentMessageId,
                  output_index: outputIndex,
                  content_index: contentIndex,
                  delta: chunk.value,
                }),
              });
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              // Close current message if open
              if (currentMessageId) {
                const outputItem = await closeMessageOutputItem(
                  sseStream,
                  currentMessageId,
                  outputIndex,
                  contentIndex,
                  accumulatedText,
                );
                output.push(outputItem);
                outputIndex++;
                currentMessageId = null;
                accumulatedText = "";
              }

              // Emit function call events
              const fcId = generateFunctionCallId();
              const callId = chunk.callId;
              const argsStr = JSON.stringify(chunk.input ?? {});
              totalOutputText += JSON.stringify(chunk);

              await sseStream.writeSSE({
                event: "response.output_item.added",
                data: JSON.stringify({
                  type: "response.output_item.added",
                  output_index: outputIndex,
                  item: {
                    type: "function_call",
                    id: fcId,
                    call_id: callId,
                    name: chunk.name,
                    arguments: "",
                    status: "in_progress",
                  },
                }),
              });

              await sseStream.writeSSE({
                event: "response.function_call_arguments.delta",
                data: JSON.stringify({
                  type: "response.function_call_arguments.delta",
                  item_id: fcId,
                  output_index: outputIndex,
                  delta: argsStr,
                }),
              });

              await sseStream.writeSSE({
                event: "response.function_call_arguments.done",
                data: JSON.stringify({
                  type: "response.function_call_arguments.done",
                  item_id: fcId,
                  output_index: outputIndex,
                  arguments: argsStr,
                }),
              });

              output.push({
                type: "function_call",
                id: fcId,
                call_id: callId,
                name: chunk.name,
                arguments: argsStr,
                status: "completed",
              });

              await sseStream.writeSSE({
                event: "response.output_item.done",
                data: JSON.stringify({
                  type: "response.output_item.done",
                  output_index: outputIndex,
                  item: output[outputIndex],
                }),
              });

              outputIndex++;
            }
          }

          // Close any remaining message
          if (currentMessageId) {
            const outputItem = await closeMessageOutputItem(
              sseStream,
              currentMessageId,
              outputIndex,
              contentIndex,
              accumulatedText,
            );
            output.push(outputItem);
            outputIndex++;
          }

          // Count output tokens
          const outputTokens = await client.countTokens(
            totalOutputText,
            cancellationToken,
          );

          cancellationTokenSource.dispose();

          const usage = {
            input_tokens: inputTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: inputTokens + outputTokens,
          };

          // Emit response.completed
          await sseStream.writeSSE({
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              response: {
                ...baseResponse,
                status: "completed",
                output,
                usage,
              },
            }),
          });

          logger.info(
            `← /v1/responses (stream) | input: ${inputTokens} | output: ${outputTokens}`,
          );
        },
        async (error, sseStream) => {
          logger.error("✕ /v1/responses (stream) |", error);
          cancellationTokenSource.dispose();

          const responseId = generateResponseId();
          const createdAt = getCurrentTimestamp();

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
                  code: "server_error",
                  message:
                    error instanceof Error ? error.message : String(error),
                },
                incomplete_details: null,
                usage: null,
                metadata,
              },
            }),
          });
        },
      );
    } catch (error) {
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
