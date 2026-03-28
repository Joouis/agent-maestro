import * as assert from "assert";
import type { Context } from "hono";

import { resolveModelId } from "../../server/routes/anthropicRoutes";
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
