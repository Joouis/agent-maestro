import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { Responses } from "openai/resources/responses/responses";
import * as vscode from "vscode";

import { getChatModelClient } from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import { CommonResponseError } from "../schemas/openai";
import { handleErrorWithLogging } from "../utils/errorDiagnostics";
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
} from "../utils/openaiResponses";

// OpenAPI route definition for /v1/responses
const createResponseRoute = createRoute({
  method: "post",
  path: "/v1/responses",
  tags: ["OpenAI API"],
  summary: "Create a model response with OpenAI Responses API",
  description: `Create a model response using the OpenAI Responses API interface, powered by VSCode Language Models.

Limitations:
- previous_response_id / conversation not supported (stateless)
- Only function tools supported (file_search, web_search, etc. ignored)
- Images supported via base64 data URI only`,
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
              "OpenAI Responses API response. See https://platform.openai.com/docs/api-reference/responses/create",
            ),
        },
        "text/event-stream": {
          schema: z
            .object()
            .describe(
              "OpenAI Responses API streaming events. See https://platform.openai.com/docs/api-reference/responses/create",
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
      // 1. Parse request
      const requestBody =
        (await c.req.json()) as Responses.ResponseCreateParams;
      rawRequestBody = requestBody;
      requestedModelId = requestBody.model ?? "";

      // 2. Validate unsupported stateful parameters
      if (requestBody.previous_response_id) {
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

      if (requestBody.conversation) {
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
      if (!requestBody.model) {
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

      if (!requestBody.input && !requestBody.instructions) {
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
      const { client, error: clientError } = await getChatModelClient(
        requestBody.model,
      );

      if (clientError) {
        return c.json(clientError, 404);
      }

      // 5. Count input tokens
      const requestBodyStr = JSON.stringify(requestBody);
      logger.debug("/v1/responses payload:", requestBodyStr);
      const cancellationToken = new vscode.CancellationTokenSource().token;
      inputTokens = await client.countTokens(requestBodyStr, cancellationToken);

      logger.info(
        `→ /v1/responses | model: ${
          requestBody.model === client.id
            ? requestBody.model
            : `${requestBody.model} → ${client.id}`
        } | input: ${inputTokens}`,
      );

      // 6. Convert input to VSCode messages
      const vsCodeMessages = convertResponsesInputToVSCode(
        requestBody.input,
        requestBody.instructions,
      );
      lmChatMessages = vsCodeMessages;

      // 7. Build request options
      const shouldPassTools =
        requestBody.tool_choice !== "none" &&
        requestBody.tools &&
        requestBody.tools.length > 0;

      const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
        justification:
          "OpenAI Responses API endpoint using VS Code Language Model API",
        modelOptions: {
          maxTokens: requestBody.max_output_tokens,
          temperature: requestBody.temperature,
          top_p: requestBody.top_p,
        },
        tools: shouldPassTools
          ? convertResponsesToolsToVSCode(requestBody.tools)
          : undefined,
        toolMode: shouldPassTools
          ? convertToolChoice(requestBody.tool_choice as ToolChoice)
          : undefined,
      };

      // 8. Send request to VSCode LM
      const response = await client.sendRequest(
        vsCodeMessages,
        lmRequestOptions,
        cancellationToken,
      );

      const { stream = false, model: modelId, metadata = {} } = requestBody;

      // 9. Handle streaming response
      if (stream) {
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
              model: modelId,
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
              accumulatedText,
              cancellationToken,
            );

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
                  model: modelId,
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
      }

      // 10. Handle non-streaming response
      let accumulatedText = "";
      const toolCalls: { callId: string; name: string; input: unknown }[] = [];

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
        accumulatedText +
          toolCalls.map((tc) => JSON.stringify(tc.input)).join(""),
        cancellationToken,
      );

      // Build response
      const responseObj = {
        id: generateResponseId(),
        object: "response",
        status: "completed",
        created_at: getCurrentTimestamp(),
        model: modelId,
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

      return c.json(responseObj);
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
