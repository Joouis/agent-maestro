import * as assert from "assert";
import type { Context } from "hono";

import { resolveModelId } from "../../server/routes/anthropicRoutes";
import { stripCc1mSuffix, tagCc1mSuffix } from "../../utils/cc1m";
import { jaccardSimilarity } from "../../utils/chatModels";

function createMockContext(headers: Record<string, string> = {}): Context {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as any as Context;
}

suite("Model Resolution Test Suite", () => {
  suite("resolveModelId", () => {
    test("should append -1m when context-1m beta header is present", () => {
      const ctx = createMockContext({
        "anthropic-beta":
          "context-1m-2025-08-07,interleaved-thinking-2025-05-14",
      });
      assert.strictEqual(
        resolveModelId("claude-opus-4-6", ctx),
        "claude-opus-4-6-1m",
      );
    });

    test("should not double-append -1m if model already ends with -1m", () => {
      const ctx = createMockContext({
        "anthropic-beta": "context-1m-2025-08-07",
      });
      assert.strictEqual(
        resolveModelId("claude-opus-4-6-1m", ctx),
        "claude-opus-4-6-1m",
      );
    });

    test("should return model unchanged when no beta header", () => {
      const ctx = createMockContext();
      assert.strictEqual(
        resolveModelId("claude-opus-4-6", ctx),
        "claude-opus-4-6",
      );
    });

    test("should return model unchanged when beta header has no context-1m", () => {
      const ctx = createMockContext({
        "anthropic-beta": "interleaved-thinking-2025-05-14",
      });
      assert.strictEqual(
        resolveModelId("claude-opus-4-6", ctx),
        "claude-opus-4-6",
      );
    });
  });

  suite("stripCc1mSuffix", () => {
    test("removes trailing [1m] suffix", () => {
      assert.strictEqual(
        stripCc1mSuffix("claude-opus-4-6-1m[1m]"),
        "claude-opus-4-6-1m",
      );
    });

    test("returns model unchanged when no suffix is present", () => {
      assert.strictEqual(stripCc1mSuffix("claude-opus-4-6"), "claude-opus-4-6");
    });

    test("only strips a terminal suffix, not occurrences elsewhere", () => {
      assert.strictEqual(
        stripCc1mSuffix("claude-[1m]-opus"),
        "claude-[1m]-opus",
      );
    });

    test("is idempotent on repeated application", () => {
      const once = stripCc1mSuffix("claude-opus-4-6-1m[1m]");
      assert.strictEqual(stripCc1mSuffix(once), once);
    });

    test("handles empty string", () => {
      assert.strictEqual(stripCc1mSuffix(""), "");
    });

    test("returns non-string input untouched without throwing", () => {
      assert.strictEqual(stripCc1mSuffix(undefined), undefined);
      assert.strictEqual(stripCc1mSuffix(null), null);
    });
  });

  suite("tagCc1mSuffix", () => {
    test("appends [1m] to a -1m variant", () => {
      assert.strictEqual(
        tagCc1mSuffix("claude-opus-4-6-1m"),
        "claude-opus-4-6-1m[1m]",
      );
    });

    test("does not tag non -1m models even if they contain '1m'", () => {
      assert.strictEqual(tagCc1mSuffix("claude-1m-opus"), "claude-1m-opus");
    });

    test("does not tag plain models", () => {
      assert.strictEqual(tagCc1mSuffix("claude-opus-4-6"), "claude-opus-4-6");
    });

    test("is idempotent — does not double-tag", () => {
      assert.strictEqual(
        tagCc1mSuffix("claude-opus-4-6-1m[1m]"),
        "claude-opus-4-6-1m[1m]",
      );
    });
  });

  suite("jaccardSimilarity - 1M variant matching", () => {
    test("claude-opus-4-6 should score higher against claude-opus-4.6 than claude-opus-4.6-1m", () => {
      const base = jaccardSimilarity("claude-opus-4-6", "claude-opus-4.6");
      const oneM = jaccardSimilarity("claude-opus-4-6", "claude-opus-4.6-1m");
      assert.ok(
        base > oneM,
        `Expected base (${base.toFixed(3)}) > 1m (${oneM.toFixed(3)})`,
      );
    });

    test("claude-opus-4-6-1m should score higher against claude-opus-4.6-1m than claude-opus-4.6", () => {
      const oneM = jaccardSimilarity(
        "claude-opus-4-6-1m",
        "claude-opus-4.6-1m",
      );
      const base = jaccardSimilarity("claude-opus-4-6-1m", "claude-opus-4.6");
      assert.ok(
        oneM > base,
        `Expected 1m (${oneM.toFixed(3)}) > base (${base.toFixed(3)})`,
      );
    });

    test("both variants should exceed the 0.3 threshold", () => {
      const base = jaccardSimilarity("claude-opus-4-6", "claude-opus-4.6");
      const oneM = jaccardSimilarity("claude-opus-4-6", "claude-opus-4.6-1m");
      assert.ok(base >= 0.3, `base (${base.toFixed(3)}) should be >= 0.3`);
      assert.ok(oneM >= 0.3, `1m (${oneM.toFixed(3)}) should be >= 0.3`);
    });
  });
});
