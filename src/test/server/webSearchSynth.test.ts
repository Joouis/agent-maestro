import * as assert from "assert";

import {
  buildServerToolUseBlock,
  buildWebSearchErrorBlock,
  buildWebSearchResultBlock,
  renderErrorAsToolResultText,
  renderResultsAsToolResultText,
} from "../../server/utils/webSearch/synth";
import { WebSearchError } from "../../server/utils/webSearch/types";

suite("webSearch synth", () => {
  test("buildServerToolUseBlock has correct shape", () => {
    const block = buildServerToolUseBlock("hello world", "srvtoolu_x");
    assert.strictEqual(block.type, "server_tool_use");
    assert.strictEqual(block.id, "srvtoolu_x");
    assert.strictEqual(block.name, "web_search");
    assert.deepStrictEqual(block.input, { query: "hello world" });
  });

  test("buildWebSearchResultBlock wraps results", () => {
    const block = buildWebSearchResultBlock("srvtoolu_y", [
      { title: "T1", url: "https://example.com/a", snippet: "S1" },
      {
        title: "T2",
        url: "https://example.com/b",
        snippet: "S2",
        publishedDate: "2026-01-01",
      },
    ]);
    assert.strictEqual(block.type, "web_search_tool_result");
    assert.strictEqual(block.tool_use_id, "srvtoolu_y");
    assert.ok(Array.isArray(block.content));
    const content = block.content as Array<{
      type: string;
      url: string;
      title: string;
      page_age: string | null;
      encrypted_content: string;
    }>;
    assert.strictEqual(content.length, 2);
    assert.strictEqual(content[0].type, "web_search_result");
    assert.strictEqual(content[0].url, "https://example.com/a");
    assert.strictEqual(content[0].page_age, null);
    assert.strictEqual(content[1].page_age, "2026-01-01");
    assert.ok(
      content[0].encrypted_content.length > 0,
      "encrypted_content should be populated",
    );
  });

  test("buildWebSearchErrorBlock encodes WebSearchError code", () => {
    const block = buildWebSearchErrorBlock(
      "srvtoolu_z",
      new WebSearchError("over budget", "max_uses_exceeded"),
    );
    assert.strictEqual(block.type, "web_search_tool_result");
    const content = block.content as {
      type: string;
      error_code: string;
    };
    assert.strictEqual(content.type, "web_search_tool_result_error");
    assert.strictEqual(content.error_code, "max_uses_exceeded");
  });

  test("buildWebSearchErrorBlock falls back to 'unavailable' for plain errors", () => {
    const block = buildWebSearchErrorBlock("srvtoolu_z", new Error("oops"));
    const content = block.content as {
      type: string;
      error_code: string;
    };
    assert.strictEqual(content.error_code, "unavailable");
  });

  test("renderResultsAsToolResultText renders empty as 'No results.'", () => {
    assert.strictEqual(renderResultsAsToolResultText([]), "No results.");
  });

  test("renderResultsAsToolResultText numbers + includes urls", () => {
    const text = renderResultsAsToolResultText([
      { title: "T1", url: "https://e/a", snippet: "S1" },
      { title: "T2", url: "https://e/b", snippet: "S2" },
    ]);
    assert.ok(text.includes("[1] T1"));
    assert.ok(text.includes("[2] T2"));
    assert.ok(text.includes("https://e/a"));
  });

  test("renderErrorAsToolResultText surfaces WebSearchError code", () => {
    const text = renderErrorAsToolResultText(
      new WebSearchError("ratelimit hit", "too_many_requests"),
    );
    assert.ok(text.includes("too_many_requests"));
  });
});
