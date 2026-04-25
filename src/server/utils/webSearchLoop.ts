import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import {
  WEB_SEARCH_TOOL_NAME,
  WebSearchConfig,
  isWebSearchToolDefinition,
} from "./webSearch";
import {
  buildServerToolUseBlock,
  buildWebSearchErrorBlock,
  buildWebSearchResultBlock,
  newServerToolUseId,
  renderErrorAsToolResultText,
  renderResultsAsToolResultText,
} from "./webSearch/synth";
import {
  WebSearchError,
  WebSearchProvider,
  WebSearchResult,
} from "./webSearch/types";

export interface WebSearchTurnEvent {
  /**
   * Synthetic Anthropic content block to surface to the client. The caller is
   * responsible for emitting this either as part of `content[]` (non-streaming)
   * or as `content_block_start`/`content_block_stop` SSE events (streaming).
   */
  block: Anthropic.Messages.ContentBlock;
}

export interface RunWebSearchLoopParams {
  client: vscode.LanguageModelChat;
  initialMessages: vscode.LanguageModelChatMessage[];
  initialOptions: vscode.LanguageModelChatRequestOptions;
  cancellationToken: vscode.CancellationToken;
  cfg: WebSearchConfig;
  provider: WebSearchProvider;
  tools: Anthropic.Messages.ToolUnion[] | undefined;
  /**
   * Called for each chunk produced by the model — text/tool_use parts that
   * are NOT our internal web_search call. The caller renders these normally.
   */
  onModelChunk: (
    chunk: vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart,
  ) => Promise<void>;
  /**
   * Called when the loop produces a synthesized server_tool_use or
   * web_search_tool_result block (i.e. we executed a search ourselves).
   */
  onWebSearchBlock: (event: WebSearchTurnEvent) => Promise<void>;
}

export interface WebSearchLoopResult {
  webSearchRequests: number;
  /** True if we executed at least one search (caller may want to expose in usage). */
  used: boolean;
}

/**
 * Runs a multi-turn loop with the VS Code Language Model: when the model calls
 * `web_search`, we execute it ourselves, feed the results back as a
 * tool_result, and re-issue the request. We surface the synthesized
 * `server_tool_use` and `web_search_tool_result` blocks to the caller so they
 * can be emitted to the client in Anthropic protocol shape.
 *
 * The loop terminates when the model produces a turn with no further
 * web_search calls, when the per-request budget is exhausted, or on cancel.
 */
export const runWebSearchLoop = async ({
  client,
  initialMessages,
  initialOptions,
  cancellationToken,
  cfg,
  provider,
  tools,
  onModelChunk,
  onWebSearchBlock,
}: RunWebSearchLoopParams): Promise<WebSearchLoopResult> => {
  const wsTool = (tools ?? []).find(isWebSearchToolDefinition) as
    | (Anthropic.Messages.WebSearchTool20250305 & { max_uses?: number })
    | undefined;
  const requestedMaxUses = wsTool?.max_uses;
  const budget = Math.min(
    typeof requestedMaxUses === "number"
      ? requestedMaxUses
      : cfg.maxUsesPerRequest,
    cfg.maxUsesPerRequest,
  );
  const allowedDomains = wsTool?.allowed_domains ?? undefined;
  const blockedDomains = wsTool?.blocked_domains ?? undefined;

  let messages = initialMessages;
  let webSearchRequests = 0;
  let used = false;

  // Hard ceiling on loop iterations as a safety net beyond the per-request
  // budget — covers degenerate cases where the model never stops calling.
  const HARD_TURN_CEILING = budget + 2;

  for (let turn = 0; turn < HARD_TURN_CEILING; turn++) {
    if (cancellationToken.isCancellationRequested) {
      break;
    }

    const response = await client.sendRequest(
      messages,
      initialOptions,
      cancellationToken,
    );

    /**
     * For each model chunk, if it's a web_search call we capture it; otherwise
     * we forward it to the caller. We need to collect ALL text + tool calls
     * from this turn before deciding whether to loop, because the model can
     * mix text with tool calls.
     */
    const turnTextParts: vscode.LanguageModelTextPart[] = [];
    const turnToolCalls: vscode.LanguageModelToolCallPart[] = [];
    let turnHadWebSearch = false;

    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        turnTextParts.push(chunk);
        await onModelChunk(chunk);
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        if (chunk.name === WEB_SEARCH_TOOL_NAME) {
          turnHadWebSearch = true;
          turnToolCalls.push(chunk);
          // Don't forward — we'll synthesize server_tool_use blocks instead.
        } else {
          turnToolCalls.push(chunk);
          await onModelChunk(chunk);
        }
      }
    }

    if (!turnHadWebSearch) {
      // Model is done with web_search for this conversation.
      break;
    }

    // Execute every web_search call from this turn and synthesize blocks.
    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];

    for (const call of turnToolCalls) {
      if (call.name !== WEB_SEARCH_TOOL_NAME) {
        // Non-web_search tool calls in the same turn cannot be auto-resolved
        // here; the client must answer them. Stop the loop and let the caller
        // surface them. (This is a corner case — typically web_search turns
        // don't include other tool calls.)
        logger.warn(
          `web_search loop: encountered non-web_search tool call '${call.name}' in same turn — stopping loop and surfacing to client`,
        );
        return { webSearchRequests, used };
      }

      const rawInput =
        typeof call.input === "object" && call.input !== null
          ? (call.input as { query?: unknown })
          : null;
      const query = String(rawInput?.query ?? "").trim();
      const srvToolUseId = newServerToolUseId();

      // Surface server_tool_use block (always, even on guard failure, so the
      // client can correlate our tool_use_id with the upcoming result block).
      await onWebSearchBlock({
        block: buildServerToolUseBlock(query, srvToolUseId),
      });

      let resultText: string;
      let results: WebSearchResult[] = [];
      let errored = false;

      if (!query) {
        const err = new WebSearchError("Empty query", "invalid_input");
        await onWebSearchBlock({
          block: buildWebSearchErrorBlock(srvToolUseId, err),
        });
        resultText = renderErrorAsToolResultText(err);
        errored = true;
      } else if (webSearchRequests >= budget) {
        const err = new WebSearchError(
          "Per-request budget exhausted",
          "max_uses_exceeded",
        );
        await onWebSearchBlock({
          block: buildWebSearchErrorBlock(srvToolUseId, err),
        });
        resultText = renderErrorAsToolResultText(err);
        errored = true;
      } else {
        webSearchRequests++;
        used = true;
        try {
          results = await provider.search(query, {
            maxResults: cfg.maxResults,
            allowedDomains,
            blockedDomains,
          });
          await onWebSearchBlock({
            block: buildWebSearchResultBlock(srvToolUseId, results),
          });
          resultText = renderResultsAsToolResultText(results);
        } catch (err) {
          await onWebSearchBlock({
            block: buildWebSearchErrorBlock(srvToolUseId, err),
          });
          resultText = renderErrorAsToolResultText(err);
          errored = true;
          logger.warn(
            `web_search call failed: ${(err as Error).message ?? err}`,
          );
        }
      }

      toolResultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(resultText),
        ]),
      );

      if (errored && webSearchRequests >= budget) {
        // No point continuing — feed back what we have and let the model wrap up.
      }
    }

    // Build the next-turn messages: prior messages + assistant turn (text +
    // tool_use parts) + user turn (tool_result parts).
    const assistantParts: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
    > = [...turnTextParts, ...turnToolCalls];
    messages = [
      ...messages,
      vscode.LanguageModelChatMessage.Assistant(assistantParts),
      vscode.LanguageModelChatMessage.User(toolResultParts),
    ];
  }

  return { webSearchRequests, used };
};
