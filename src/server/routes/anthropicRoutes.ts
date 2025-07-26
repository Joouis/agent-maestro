import Anthropic from "@anthropic-ai/sdk";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as vscode from "vscode";
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
        tools,
        tool_choice,
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
              input_tokens: 0,
              output_tokens: 0,
              server_tool_use: null,
              service_tier: null,
            },
            // container: null,
          };

          return reply.send(resp);
        }

        // 6. If streaming, pipe chunks as SSE
        const sendSSE = (eventType: string, data: any) => {
          const sseData = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
          reply.raw.write(sseData);
        };

        logger.info("====================== STREAMING ======================");
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        sendSSE("message_start", {
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
              input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
              service_tier: "standard",
            },
          },
        });

        let isTextBlockStarted = false;
        let isToolCallBlockStarted = false;

        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            logger.info(`Text: `, chunk);
            if (!isTextBlockStarted) {
              isTextBlockStarted = true;
              sendSSE("content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              });
            }
            sendSSE("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: chunk.value },
            });
          } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
            logger.info(`Tool call: `, chunk);
            if (!isToolCallBlockStarted) {
              isToolCallBlockStarted = true;
              sendSSE("content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: chunk.callId,
                  name: chunk.name,
                  input: chunk.input,
                },
              });
            }
            // sendSSE("content_block_delta", {
            //   type: "content_block_delta",
            //   index: 0,
            //   delta: { type: "input_json_delta", partial_json: chunk.input },
            // });
          }
        }

        sendSSE("content_block_stop", { type: "content_block_stop", index: 0 });
        sendSSE("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: isToolCallBlockStarted ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 0 },
        });
        sendSSE("message_stop", { type: "message_stop" });

        // Signal end of stream
        reply.raw.end();
        logger.info("Streaming response completed");
        return;
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
