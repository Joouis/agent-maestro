import Anthropic from "@anthropic-ai/sdk";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as vscode from "vscode";
import { v4 } from "uuid";
import { logger } from "../../utils/logger";

export async function registerAnthropicRoutes(fastify: FastifyInstance) {
  // Mock Anthropic /v1/messages endpoint with streaming support
  fastify.post<{
    Body: {
      model: string;
      messages: { role: "user" | "assistant"; content: string }[];
      max_tokens?: number;
      temperature?: number;
      top_p?: number;
      stop_sequences?: string[];
      stream?: boolean;
    };
  }>(
    "/v1/messages",
    {
      schema: {
        tags: ["Anthropic API"],
        summary: "Create a message",
        description:
          "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
        body: {
          type: "object",
          properties: {
            model: { type: "string" },
            messages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  content: { type: "string" },
                },
                required: ["role", "content"],
              },
            },
            max_tokens: { type: "number" },
            temperature: { type: "number" },
            top_p: { type: "number" },
            stop_sequences: {
              type: "array",
              items: { type: "string" },
            },
            stream: { type: "boolean" },
          },
          required: ["model", "messages"],
        },
        response: {
          200: {
            description: "Successful response",
            type: "object",
            additionalProperties: true,
          },
          500: {
            description: "Internal server error",
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const {
        model: modelId,
        messages,
        ...msgCreateParams
      } = request.body as Anthropic.Messages.MessageCreateParams;

      try {
        logger.info(`Processing Anthropic API request for model: ${modelId}`);

        // 1. Check if selected model is available in VS Code LM API
        const models = await vscode.lm.selectChatModels({});
        const client = models.find((m) => m.id === modelId);

        if (!client) {
          logger.error("No VS Code LM model available");
          return reply.status(404).send({
            error: `Model '${modelId}' not found. Use /api/v1/lm/chatModels to list available models and pass a valid model ID.`,
          });
        }
        logger.info(
          `Selected model: ${client.name} (${client.vendor}/${client.family})`,
        );

        // 2. Map Anthropic messages to VS Code LM API messages
        const vsCodeLmMessages: vscode.LanguageModelChatMessage[] =
          messages.map((m) =>
            m.role === "user"
              ? vscode.LanguageModelChatMessage.User(m.content as string)
              : vscode.LanguageModelChatMessage.Assistant(m.content as string),
          );

        // 3. Build VS Code Language Model request options
        const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
          justification:
            "Anthropic-compatible /v1/messages endpoint with streaming support using VS Code Language Model API",
          modelOptions: msgCreateParams,
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
            id: v4(),
            type: "message",
            role: "assistant",
            // TODO: what about other ContentBlock like ToolUseBlock or ThinkingBlock?
            content: [{ type: "text", text: fullText, citations: null }],
            model: modelId,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: {
              // cache_creation: null,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              input_tokens: 0,
              output_tokens: 0,
              server_tool_use: null,
              service_tier: null,
            },
            // container: null,
          };

          return reply.send(resp);
        }

        // 5. If streaming, pipe chunks as SSE
        // reply.raw.writeHead(200, {
        //     "Content-Type": "text/event-stream",
        //     "Cache-Control": "no-cache, no-transform",
        //     Connection: "keep-alive",
        //   });

        //   logger.info("Starting streaming response");
        //   for await (const fragment of response.text) {
        //     // const chunk: Anthropic.Messages. = {
        //     //   id: `chunk_${Date.now()}`,
        //     //   model,
        //     //   object: "chat.completion.chunk",
        //     //   choices: [
        //     //     { delta: { text: fragment }, index: 0, finish_reason: null },
        //     //   ],
        //     // };
        //     // reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        //     if (fragment instanceof vscode.LanguageModelTextPart) {
        //     }
        //   }
        //   // Signal end of stream
        //   reply.raw.write(`data: [DONE]\n\n`);
        //   reply.raw.end();
        //   logger.info("Streaming response completed");
        //   return;
      } catch (error) {
        logger.error("Error processing Anthropic API request:", error);
        return reply.status(500).send({
          error:
            error instanceof Error ? error.message : "Internal server error",
        });
      }
    },
  );
}
