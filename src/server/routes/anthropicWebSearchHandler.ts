import Anthropic from "@anthropic-ai/sdk";
import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import {
  AnthropicSearchLoopResult,
  PreparedAnthropicTools,
  runAnthropicWebSearchLoop,
} from "../utils/anthropicWebSearch";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  LanguageModelRequestTimeoutError,
} from "../utils/languageModelRequestLifecycle";
import { SSE_HEARTBEAT, withSseHeartbeat } from "../utils/sseHeartbeat";
import { WebSearchProvider } from "../webSearch/webSearchProvider";

interface AnthropicWebSearchHandlerOptions {
  c: Context;
  client: vscode.LanguageModelChat;
  heartbeatIntervalMs?: number;
  lifecycle: LanguageModelRequestLifecycle;
  maxTokens: number;
  messages: vscode.LanguageModelChatMessage[];
  model: string;
  preparedTools: PreparedAnthropicTools;
  provider: WebSearchProvider;
  providerTimeoutMs: number;
  requestOptions: vscode.LanguageModelChatRequestOptions;
  stream?: boolean;
}

const createServerToolUsage = (webSearchRequests: number) =>
  webSearchRequests > 0
    ? {
        web_fetch_requests: 0,
        web_search_requests: webSearchRequests,
      }
    : null;

export async function handleAnthropicWebSearch({
  c,
  client,
  heartbeatIntervalMs,
  lifecycle,
  maxTokens,
  messages,
  model,
  preparedTools,
  provider,
  providerTimeoutMs,
  requestOptions,
  stream: shouldStream,
}: AnthropicWebSearchHandlerOptions): Promise<Response> {
  const runSearchLoop = () =>
    runAnthropicWebSearchLoop({
      client,
      messages,
      baseRequestOptions: requestOptions,
      preparedTools,
      provider,
      lifecycle,
      maxTokens,
      providerTimeoutMs,
    });

  if (!shouldStream) {
    const result = await runSearchLoop();
    const response: Anthropic.Messages.Message = {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      container: null,
      content: result.content,
      stop_details: null,
      stop_reason: result.stopReason,
      stop_sequence: null,
      usage: {
        cache_creation: null,
        cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
        cache_read_input_tokens: result.usage.cache_read_input_tokens,
        inference_geo: null,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        server_tool_use: createServerToolUsage(result.webSearchRequests),
        service_tier: null,
      },
    };
    logger.info(
      `← /v1/messages | input: ${result.usage.input_tokens} | cache_read: ${result.usage.cache_read_input_tokens} | cache_creation: ${result.usage.cache_creation_input_tokens} | output: ${result.usage.output_tokens} | web_search: ${result.webSearchRequests}`,
    );
    lifecycle.dispose();
    return c.json(response);
  }

  return streamSSE(
    c,
    async (sseStream) => {
      const writeSSE = async (
        message: Anthropic.Messages.RawMessageStreamEvent,
      ) => {
        await lifecycle.waitFor(
          sseStream.writeSSE({
            event: message.type,
            data: JSON.stringify(message),
          }),
        );
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

      const resultStream = (async function* () {
        yield await runSearchLoop();
      })();
      let result: AnthropicSearchLoopResult | undefined;
      for await (const item of withSseHeartbeat(
        resultStream,
        heartbeatIntervalMs,
      )) {
        if (item === SSE_HEARTBEAT) {
          await lifecycle.waitFor(
            sseStream.writeSSE({
              event: "ping",
              data: JSON.stringify({ type: "ping" }),
            }),
          );
        } else {
          result = item;
        }
      }
      if (!result) {
        throw new Error("Anthropic web search loop returned no result");
      }

      for (const [index, block] of result.content.entries()) {
        if (block.type === "text") {
          await writeSSE({
            type: "content_block_start",
            index,
            content_block: {
              type: "text",
              text: "",
              citations: null,
            },
          });
          await writeSSE({
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          });
        } else if (block.type === "tool_use") {
          await writeSSE({
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              caller: { type: "direct" },
              name: block.name,
              input: {},
            },
          });
          await writeSSE({
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          });
        }
        await writeSSE({ type: "content_block_stop", index });
      }

      await writeSSE({
        type: "message_delta",
        delta: {
          container: null,
          stop_details: null,
          stop_reason: result.stopReason,
          stop_sequence: null,
        },
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          server_tool_use: createServerToolUsage(result.webSearchRequests),
        },
      });
      await writeSSE({ type: "message_stop" });
      logger.info(
        `← /v1/messages (stream) | input: ${result.usage.input_tokens} | cache_read: ${result.usage.cache_read_input_tokens} | cache_creation: ${result.usage.cache_creation_input_tokens} | output: ${result.usage.output_tokens} | web_search: ${result.webSearchRequests}`,
      );
      lifecycle.dispose();
    },
    async (error, sseStream) => {
      if (error instanceof LanguageModelClientDisconnectedError) {
        logger.info("/v1/messages | client disconnected");
        lifecycle.dispose();
        await sseStream.close();
        return;
      }
      if (error instanceof LanguageModelRequestTimeoutError) {
        try {
          await sseStream.writeSSE({
            event: "error",
            data: JSON.stringify({
              type: "error",
              error: {
                type: "timeout_error",
                message: error.message,
              },
              request_id: null,
            }),
          });
        } finally {
          lifecycle.dispose();
          await sseStream.close();
        }
        return;
      }
      logger.error("✕ /v1/messages web search stream |", error);
      lifecycle.dispose();
    },
  );
}
