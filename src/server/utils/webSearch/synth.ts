import Anthropic from "@anthropic-ai/sdk";

import { WebSearchError, WebSearchResult } from "./types";

let counter = 0;
const newId = () =>
  `srvtoolu_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export const newServerToolUseId = newId;

/**
 * Build the `server_tool_use` content block that Anthropic emits when its
 * backend calls web_search internally.
 */
export const buildServerToolUseBlock = (
  query: string,
  id: string = newId(),
): Anthropic.Messages.ServerToolUseBlock => ({
  type: "server_tool_use",
  id,
  name: "web_search",
  input: { query },
});

/**
 * Wrap our search results into the `web_search_tool_result` block shape
 * Anthropic returns. `encrypted_content` is opaque to the client — Claude Code
 * never feeds it back to a real Anthropic backend, only to us — so we use a
 * deterministic base64 payload.
 */
export const buildWebSearchResultBlock = (
  toolUseId: string,
  results: WebSearchResult[],
): Anthropic.Messages.WebSearchToolResultBlock => ({
  type: "web_search_tool_result",
  tool_use_id: toolUseId,
  content: results.map((r) => ({
    type: "web_search_result",
    url: r.url,
    title: r.title,
    encrypted_content: Buffer.from(
      JSON.stringify({ snippet: r.snippet, url: r.url, title: r.title }),
    ).toString("base64"),
    page_age: r.publishedDate ?? null,
  })),
});

export const buildWebSearchErrorBlock = (
  toolUseId: string,
  err: unknown,
): Anthropic.Messages.WebSearchToolResultBlock => {
  const code = err instanceof WebSearchError ? err.code : "unavailable";
  return {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: {
      type: "web_search_tool_result_error",
      error_code: code,
    },
  } as Anthropic.Messages.WebSearchToolResultBlock;
};

/**
 * Render results as plain text for the model's next turn (separate from the
 * on-the-wire `web_search_tool_result` block, which is for the client).
 */
export const renderResultsAsToolResultText = (
  results: WebSearchResult[],
): string => {
  if (results.length === 0) {
    return "No results.";
  }
  return results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n${r.url}${
          r.publishedDate ? ` (${r.publishedDate})` : ""
        }\n${r.snippet}`,
    )
    .join("\n\n");
};

export const renderErrorAsToolResultText = (err: unknown): string => {
  if (err instanceof WebSearchError) {
    return `Search failed: ${err.code} (${err.message})`;
  }
  return `Search failed: ${(err as Error).message ?? "unknown error"}`;
};
