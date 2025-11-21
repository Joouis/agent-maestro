import { FinishReason, type Part } from "@google/genai";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";

import { getChatModelClient } from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import {
  GeminiErrorResponseSchema,
  GenerateContentRequest,
  GenerateContentResponse,
} from "../schemas/gemini";
import {
  convertGeminiContentsToVSCode,
  convertGeminiSystemInstructionToVSCode,
  convertGeminiToolConfigToVSCode,
  convertGeminiToolsToVSCode,
} from "../utils/gemini";

// ============================================================================
// Shared Helper Functions
// ============================================================================

/**
 * Prepare Gemini request by converting to VSCode format and counting tokens
 * Used by both generateContent and countTokens endpoints
 */
const prepareGeminiRequest = async ({
  requestBody,
  client,
}: {
  requestBody: GenerateContentRequest;
  client: vscode.LanguageModelChat;
}) => {
  const { systemInstruction, contents, tools, generationConfig, toolConfig } =
    requestBody;

  // Convert to VSCode messages
  const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
    ...convertGeminiSystemInstructionToVSCode(systemInstruction),
    ...convertGeminiContentsToVSCode(contents || []),
  ];

  // Count input tokens
  let inputTokenCount = 0;
  const cancellationToken = new vscode.CancellationTokenSource().token;
  for (const msg of vsCodeLmMessages) {
    inputTokenCount += await client.countTokens(msg, cancellationToken);
  }

  // Build request options
  const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
    justification:
      "Gemini-compatible API endpoint using VS Code Language Model API",
    modelOptions: generationConfig,
    tools: convertGeminiToolsToVSCode(tools),
    toolMode: convertGeminiToolConfigToVSCode(
      toolConfig?.functionCallingConfig,
    ),
  };

  return {
    vsCodeLmMessages,
    inputTokenCount,
    cancellationToken,
    lmRequestOptions,
  };
};

// ============================================================================
// OpenAPI Route Definitions
// ============================================================================

const generateContentRoute = createRoute({
  method: "post",
  path: "/v1beta/models/:modelWithMethod{[^/\\:]+\\:generateContent}",
  tags: ["Google Gemini API"],
  summary: "Generate content with Gemini-compatible API",
  description:
    "Generate content using the Gemini-compatible API interface, powered by VSCode Language Models. Always returns non-streaming responses.",
  request: {
    params: z.object({
      modelWithMethod: z
        .string()
        .describe(
          "Model ID with method (e.g., gemini-2.5-pro:generateContent)",
        ),
    }),
    body: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Gemini GenerateContent request body. See https://ai.google.dev/api/generate-content#request-body for schema details.",
            ),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Gemini GenerateContent response body. See https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse for schema details.",
            ),
        },
      },
      description: "Successfully generated content (non-streaming)",
    },
    400: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

const streamGenerateContentRoute = createRoute({
  method: "post",
  path: "/v1beta/models/:modelWithMethod{[^/\\:]+\\:streamGenerateContent}",
  tags: ["Google Gemini API"],
  summary: "Stream generate content with Gemini-compatible API",
  description:
    "Stream generate content using the Gemini-compatible API interface, powered by VSCode Language Models. Always returns Server-Sent Events stream.",
  request: {
    params: z.object({
      modelWithMethod: z
        .string()
        .describe(
          "Model ID with method (e.g., gemini-2.5-pro:streamGenerateContent)",
        ),
    }),
    body: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Gemini GenerateContent request body. See https://ai.google.dev/api/generate-content#request-body_1 for schema details.",
            ),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "text/event-stream": {
          schema: z
            .string()
            .describe(
              "Server-sent events stream for streaming responses. See https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse for schema details.",
            ),
        },
      },
      description: "Successfully generated content stream",
    },
    400: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

const countTokensRoute = createRoute({
  method: "post",
  path: "/v1beta/models/:modelWithMethod{[^/\\:]+\\:countTokens}",
  tags: ["Google Gemini API"],
  summary: "Count tokens with Gemini-compatible API",
  description:
    "Count input tokens using the Gemini-compatible API interface, powered by VSCode Language Models.",
  request: {
    params: z.object({
      modelWithMethod: z
        .string()
        .describe("Model ID with method (e.g., gemini-2.5-pro:countTokens)"),
    }),
    body: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Gemini CountTokens request body. See https://ai.google.dev/api/tokens#request-body for schema details.",
            ),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          // Skip schema validation to support API schema changes without requiring immediate updates.
          schema: z
            .object()
            .describe(
              "Gemini CountTokens response body. See https://ai.google.dev/api/tokens#response-body for schema details.",
            ),
        },
      },
      description: "Successfully counted tokens",
    },
    400: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
    },
    404: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Model not found",
    },
    500: {
      content: {
        "application/json": {
          schema: GeminiErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

// ============================================================================
// Route Handlers
// ============================================================================

export function registerGeminiRoutes(app: OpenAPIHono) {
  // POST /v1beta/models/{model}:generateContent
  app.openapi(generateContentRoute, async (c: Context) => {
    try {
      // Parse request
      const { modelWithMethod } = c.req.param();
      const modelId = modelWithMethod.split(":")[0]; // Extract model ID from "model:generateContent"
      const requestBody = await c.req.json();

      logger.debug(
        `/v1beta/models/${modelId}:generateContent payload:`,
        JSON.stringify(requestBody, null, 2),
      );

      // 1. Get chat model client
      const { client, error: clientError } = await getChatModelClient(modelId);

      if (clientError) {
        return c.json(
          {
            error: {
              code: 404,
              message: clientError.error.message,
              status: "NOT_FOUND",
            },
          },
          404,
        );
      }

      logger.info(
        `Received generateContent call with model: ${client.name} (${client.vendor}/${client.family})`,
      );

      // 2. Prepare request
      const {
        vsCodeLmMessages,
        inputTokenCount,
        cancellationToken,
        lmRequestOptions,
      } = await prepareGeminiRequest({ requestBody, client });

      // 3. Send request to VSCode LM API
      const response = await client.sendRequest(
        vsCodeLmMessages,
        lmRequestOptions,
        cancellationToken,
      );

      // 4. Process response (always non-streaming for generateContent)
      const parts: Part[] = [];
      let accumulatedText = "";

      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          const text = chunk.value;
          parts.push({ text });
          accumulatedText += text;
        } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
          parts.push({
            functionCall: {
              id: chunk.callId,
              name: chunk.name,
              args: chunk.input as Record<string, unknown>,
            },
          });
          accumulatedText += JSON.stringify(chunk);
        }
        // Now chunk could be reasoning part (vscode_reasoning_done), so we skip it
      }

      // Count output tokens
      const outputTokenCount = accumulatedText
        ? await client.countTokens(accumulatedText)
        : 0;

      const geminiResponse: GenerateContentResponse = {
        candidates: [
          {
            content: {
              parts,
              role: "model",
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: inputTokenCount,
          candidatesTokenCount: outputTokenCount,
          totalTokenCount: inputTokenCount + outputTokenCount,
        },
        modelVersion: modelId,
      };

      logger.debug(
        "generateContent response:",
        JSON.stringify(geminiResponse, null, 2),
      );

      return c.json(geminiResponse, 200);
    } catch (error) {
      logger.error("Gemini API generateContent request failed:", error);
      return c.json(
        {
          error: {
            code: 500,
            message:
              error instanceof Error ? error.message : "Internal server error",
            status: "INTERNAL_ERROR",
          },
        },
        500,
      );
    }
  });

  // POST /v1beta/models/{model}:streamGenerateContent
  app.openapi(
    streamGenerateContentRoute,
    async (c: Context): Promise<Response> => {
      try {
        // Parse request
        const { modelWithMethod } = c.req.param();
        const modelId = modelWithMethod.split(":")[0]; // Extract model ID from "model:streamGenerateContent"
        const requestBody = await c.req.json();

        logger.debug(
          `/v1beta/models/${modelId}:streamGenerateContent payload:`,
          JSON.stringify(requestBody, null, 2),
        );

        // 1. Get chat model client
        const { client, error: clientError } =
          await getChatModelClient(modelId);

        if (clientError) {
          return c.json(
            {
              error: {
                code: 404,
                message: clientError.error.message,
                status: "NOT_FOUND",
              },
            },
            404,
          );
        }

        logger.info(
          `Received streamGenerateContent call with model: ${client.name} (${client.vendor}/${client.family})`,
        );

        // 2. Prepare request
        const {
          vsCodeLmMessages,
          inputTokenCount,
          cancellationToken,
          lmRequestOptions,
        } = await prepareGeminiRequest({ requestBody, client });

        // 3. Send request to VSCode LM API
        const response = await client.sendRequest(
          vsCodeLmMessages,
          lmRequestOptions,
          cancellationToken,
        );

        // 4. Always stream the response
        return streamSSE(
          c,
          async (stream) => {
            try {
              let accumulatedText = "";

              for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                  const text = chunk.value;
                  accumulatedText += text;

                  // Send streaming chunk
                  const streamChunk: GenerateContentResponse = {
                    candidates: [
                      {
                        content: {
                          parts: [{ text }],
                          role: "model",
                        },
                        index: 0,
                      },
                    ],
                  };

                  await stream.writeSSE({
                    data: JSON.stringify(streamChunk),
                  });
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                  const functionCallPart: Part = {
                    functionCall: {
                      id: chunk.callId,
                      name: chunk.name,
                      args: chunk.input as Record<string, unknown>,
                    },
                  };
                  accumulatedText += JSON.stringify(chunk);

                  // Send function call chunk
                  const streamChunk: GenerateContentResponse = {
                    candidates: [
                      {
                        content: {
                          parts: [functionCallPart],
                          role: "model",
                        },
                        index: 0,
                      },
                    ],
                  };

                  await stream.writeSSE({
                    data: JSON.stringify(streamChunk),
                  });
                }
                // Now chunk could be reasoning part (vscode_reasoning_done), so we skip it
              }

              // Send final chunk with usage metadata
              const outputTokenCount = accumulatedText
                ? await client.countTokens(accumulatedText)
                : 0;

              const finalChunk: GenerateContentResponse = {
                candidates: [
                  {
                    finishReason: FinishReason.STOP,
                    index: 0,
                  },
                ],
                usageMetadata: {
                  promptTokenCount: inputTokenCount,
                  candidatesTokenCount: outputTokenCount,
                  totalTokenCount: inputTokenCount + outputTokenCount,
                },
                modelVersion: modelId,
              };

              await stream.writeSSE({
                data: JSON.stringify(finalChunk),
              });

              logger.info("Streaming streamGenerateContent completed");
            } catch (streamError) {
              logger.error("Error in streaming:", streamError);
              throw streamError;
            }
          },
          async (error, stream) => {
            logger.error("Stream error occurred:", error);

            // Send final chunk with error finish reason
            const errorChunk: GenerateContentResponse = {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: String(error),
                      },
                    ],
                    role: "model",
                  },
                  finishReason: FinishReason.OTHER,
                  index: 0,
                },
              ],
              usageMetadata: {
                promptTokenCount: inputTokenCount,
                candidatesTokenCount: 0,
                totalTokenCount: inputTokenCount,
              },
              modelVersion: modelId,
            };

            await stream.writeSSE({
              data: JSON.stringify(errorChunk),
            });
          },
        );
      } catch (error) {
        logger.error("Gemini API streamGenerateContent request failed:", error);
        return c.json(
          {
            error: {
              code: 500,
              message:
                error instanceof Error
                  ? error.message
                  : "Internal server error",
              status: "INTERNAL_ERROR",
            },
          },
          500,
        );
      }
    },
  );

  // POST /v1beta/models/{model}:countTokens
  app.openapi(countTokensRoute, async (c: Context) => {
    try {
      // Parse request
      const { modelWithMethod } = c.req.param();
      const modelId = modelWithMethod.split(":")[0]; // Extract model ID from "model:countTokens"
      const requestBody = await c.req.json();

      logger.debug(
        `/v1beta/models/${modelId}:countTokens payload:`,
        JSON.stringify(requestBody, null, 2),
      );

      // 1. Get chat model client
      const { client, error: clientError } = await getChatModelClient(modelId);

      if (clientError) {
        return c.json(
          {
            error: {
              code: 404,
              message: clientError.error.message,
              status: "NOT_FOUND",
            },
          },
          404,
        );
      }

      logger.info(
        `Received countTokens call with model: ${client.name} (${client.vendor}/${client.family})`,
      );

      // 2. Prepare request and get token count
      const { inputTokenCount } = await prepareGeminiRequest({
        requestBody,
        client,
      });

      return c.json(
        {
          totalTokens: inputTokenCount,
        },
        200,
      );
    } catch (error) {
      logger.error("Gemini API countTokens request failed:", error);
      return c.json(
        {
          error: {
            code: 500,
            message:
              error instanceof Error ? error.message : "Internal server error",
            status: "INTERNAL_ERROR",
          },
        },
        500,
      );
    }
  });
}
