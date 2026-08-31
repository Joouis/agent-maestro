import { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  ResponseFunctionWebSearch,
  ResponseUsage,
} from "openai/resources/responses/responses";
import * as vscode from "vscode";

import { logger } from "../../../utils/logger";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  LanguageModelRequestTimeoutError,
} from "../../utils/languageModelRequestLifecycle";
import {
  OpenAIResponsesEnvelope,
  OpenAIResponsesStatus,
  OutputItem,
  buildOpenAIResponsesEnvelope,
  closeMessageOutputItem,
  generateResponseId,
  getCurrentTimestamp,
  openMessageOutputItem,
  writeCustomToolCallOutputItem,
  writeFunctionToolCallOutputItem,
  writeMessageOutputTextDelta,
} from "../../utils/openaiResponses";
import {
  OpenAIResponsesSearchLoopCallbacks,
  PreparedOpenAIResponsesTools,
  runOpenAIResponsesWebSearchLoop,
} from "../../utils/openaiResponsesWebSearch";
import { SSE_HEARTBEAT, withSseHeartbeat } from "../../utils/sseHeartbeat";
import { WebSearchProvider } from "../../webSearch/webSearchProvider";

interface OpenAIResponsesWebSearchHandlerOptions {
  c: Context;
  client: vscode.LanguageModelChat;
  heartbeatIntervalMs?: number;
  lifecycle: LanguageModelRequestLifecycle;
  maxOutputTokens?: number;
  messages: vscode.LanguageModelChatMessage[];
  metadata: unknown;
  model: string;
  parallelToolCalls?: boolean | null;
  preparedTools: PreparedOpenAIResponsesTools;
  provider: WebSearchProvider;
  providerTimeoutMs: number;
  publicTools: unknown[];
  requestOptions: vscode.LanguageModelChatRequestOptions;
  stream?: boolean | null;
  toolChoice?: unknown;
}

const outputTextPart = (item: OutputItem) =>
  item.type === "message"
    ? item.content.find((part) => part.type === "output_text")
    : undefined;

export async function handleOpenAIResponsesWebSearch({
  c,
  client,
  heartbeatIntervalMs,
  lifecycle,
  maxOutputTokens,
  messages,
  metadata,
  model,
  parallelToolCalls,
  preparedTools,
  provider,
  providerTimeoutMs,
  publicTools,
  requestOptions,
  stream: shouldStream,
  toolChoice,
}: OpenAIResponsesWebSearchHandlerOptions): Promise<Response> {
  const responseId = generateResponseId();
  const createdAt = getCurrentTimestamp();
  const buildResponseEnvelope = (
    status: OpenAIResponsesStatus,
    output: OutputItem[],
    usage: ResponseUsage | null,
    completedAt: number | null,
    error: { code: string; message: string } | null = null,
  ): OpenAIResponsesEnvelope =>
    buildOpenAIResponsesEnvelope({
      id: responseId,
      createdAt,
      model,
      metadata,
      parallelToolCalls,
      toolChoice,
      tools: publicTools,
      status,
      output,
      usage,
      completedAt,
      error,
    });
  const runSearchLoop = (callbacks?: OpenAIResponsesSearchLoopCallbacks) =>
    runOpenAIResponsesWebSearchLoop({
      client,
      messages,
      baseRequestOptions: requestOptions,
      preparedTools,
      provider,
      lifecycle,
      maxOutputTokens,
      providerTimeoutMs,
      preserveLegacyNonStreamingOutput: !shouldStream,
      callbacks,
    });

  if (!shouldStream) {
    const result = await runSearchLoop();
    const status = result.incomplete ? "incomplete" : "completed";
    const selectedSearch = result.output.some(
      ({ type }) => type === "web_search_call",
    );
    const response = selectedSearch
      ? buildResponseEnvelope(
          status,
          result.output,
          result.usage,
          getCurrentTimestamp(),
        )
      : {
          id: responseId,
          object: "response" as const,
          status,
          created_at: createdAt,
          model,
          output: result.output,
          error: null,
          incomplete_details: result.incomplete
            ? { reason: "max_output_tokens" }
            : null,
          usage: result.usage,
          metadata,
        };
    logger.debug("/v1/responses web search response:");
    logger.debug(JSON.stringify(response, null, 2));
    logger.info(
      `← /v1/responses | input: ${result.usage.input_tokens} | cache_read: ${result.usage.input_tokens_details.cached_tokens} | output: ${result.usage.output_tokens} | web_search: ${result.webSearchRequests}`,
    );
    lifecycle.dispose();
    return c.json(response);
  }

  const sequenceNumberRef = { value: 0 };
  return streamSSE(
    c,
    async (sseStream) => {
      const writeSSE = (message: Parameters<typeof sseStream.writeSSE>[0]) =>
        lifecycle.waitFor(sseStream.writeSSE(message));
      const writeEvent = (event: string, data: Record<string, unknown>) =>
        writeSSE({
          event,
          data: JSON.stringify({
            ...data,
            sequence_number: sequenceNumberRef.value++,
          }),
        });

      await writeEvent("response.created", {
        type: "response.created",
        response: buildResponseEnvelope("in_progress", [], null, null),
      });
      await writeEvent("response.in_progress", {
        type: "response.in_progress",
        response: buildResponseEnvelope("in_progress", [], null, null),
      });

      let searchOutputEmitted = false;
      const callbacks: OpenAIResponsesSearchLoopCallbacks = {
        onSearchCallStarted: async (item) => {
          searchOutputEmitted = true;
          await writeEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            item,
          });
          await writeEvent("response.web_search_call.in_progress", {
            type: "response.web_search_call.in_progress",
            output_index: 0,
            item_id: item.id,
          });
        },
        onProviderStarted: async (itemId) => {
          await writeEvent("response.web_search_call.searching", {
            type: "response.web_search_call.searching",
            output_index: 0,
            item_id: itemId,
          });
        },
        onSearchCallCompleted: async (item) => {
          await writeEvent("response.web_search_call.completed", {
            type: "response.web_search_call.completed",
            output_index: 0,
            item_id: item.id,
          });
          await writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: 0,
            item,
          });
        },
      };

      const resultStream = (async function* () {
        yield await runSearchLoop(callbacks);
      })();
      let result:
        | Awaited<ReturnType<typeof runOpenAIResponsesWebSearchLoop>>
        | undefined;
      for await (const item of withSseHeartbeat(
        resultStream,
        heartbeatIntervalMs,
      )) {
        if (item === SSE_HEARTBEAT) {
          await lifecycle.waitFor(sseStream.write(": keep-alive\n\n"));
        } else {
          result = item;
        }
      }
      if (!result) {
        throw new Error("OpenAI Responses web search loop returned no result");
      }

      let outputIndex = searchOutputEmitted ? 1 : 0;
      for (const item of result.output) {
        if (item.type === "web_search_call") {
          continue;
        }

        if (item.type === "message") {
          const part = outputTextPart(item);
          if (!part) {
            continue;
          }
          await openMessageOutputItem(
            writeSSE,
            item.id,
            outputIndex,
            0,
            sequenceNumberRef,
          );
          await writeMessageOutputTextDelta(
            writeSSE,
            item.id,
            outputIndex,
            0,
            part.text,
            sequenceNumberRef,
          );
          await closeMessageOutputItem(
            writeSSE,
            item.id,
            outputIndex,
            0,
            part.text,
            sequenceNumberRef,
            {
              annotations: part.annotations,
              status: item.status,
            },
          );
          outputIndex++;
          continue;
        }

        if (item.type === "custom_tool_call") {
          await writeCustomToolCallOutputItem(
            writeSSE,
            item,
            outputIndex,
            sequenceNumberRef,
          );
          outputIndex++;
          continue;
        }

        await writeFunctionToolCallOutputItem(
          writeSSE,
          item,
          outputIndex,
          sequenceNumberRef,
        );
        outputIndex++;
      }

      const terminalStatus = result.incomplete ? "incomplete" : "completed";
      await writeEvent(`response.${terminalStatus}`, {
        type: `response.${terminalStatus}`,
        response: buildResponseEnvelope(
          terminalStatus,
          result.output,
          result.usage,
          getCurrentTimestamp(),
        ),
      });
      logger.info(
        `← /v1/responses (stream) | input: ${result.usage.input_tokens} | cache_read: ${result.usage.input_tokens_details.cached_tokens} | output: ${result.usage.output_tokens} | web_search: ${result.webSearchRequests}`,
      );
      lifecycle.dispose();
    },
    async (error, sseStream) => {
      if (error instanceof LanguageModelClientDisconnectedError) {
        logger.info("/v1/responses | client disconnected");
        lifecycle.dispose();
        await sseStream.close();
        return;
      }

      logger.error("✕ /v1/responses web search stream |", error);
      try {
        await sseStream.writeSSE({
          event: "response.failed",
          data: JSON.stringify({
            type: "response.failed",
            sequence_number: sequenceNumberRef.value++,
            response: buildResponseEnvelope("failed", [], null, null, {
              code:
                error instanceof LanguageModelRequestTimeoutError
                  ? "request_timeout"
                  : "server_error",
              message: error instanceof Error ? error.message : String(error),
            }),
          }),
        });
      } finally {
        lifecycle.dispose();
        await sseStream.close();
      }
    },
  );
}
