import * as assert from "assert";

import { jaccardSimilarity } from "../../utils/chatModels";
import {
  resolveClaudeCodeModelId,
  withClaudeCode1mSuffix,
} from "../../utils/claude";

suite("Model Resolution Test Suite", () => {
  suite("resolveClaudeCodeModelId", () => {
    test("appends -1m-internal when context-1m beta header is present", () => {
      assert.strictEqual(
        resolveClaudeCodeModelId(
          "claude-opus-4-7",
          "context-1m-2025-08-07,interleaved-thinking-2025-05-14",
        ),
        "claude-opus-4-7-1m-internal",
      );
    });

    test("does not append when model already contains 1m", () => {
      assert.strictEqual(
        resolveClaudeCodeModelId("claude-opus-4-7-1m", "context-1m-2025-08-07"),
        "claude-opus-4-7-1m",
      );
      assert.strictEqual(
        resolveClaudeCodeModelId(
          "claude-opus-4.7-1m-internal",
          "context-1m-2025-08-07",
        ),
        "claude-opus-4.7-1m-internal",
      );
    });

    test("returns model unchanged without context-1m beta header", () => {
      assert.strictEqual(
        resolveClaudeCodeModelId(
          "claude-opus-4-7",
          "interleaved-thinking-2025-05-14",
        ),
        "claude-opus-4-7",
      );
    });
  });

  suite("withClaudeCode1mSuffix", () => {
    test("appends [1m] to a -1m variant", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4-6-1m"),
        "claude-opus-4-6-1m[1m]",
      );
    });

    test("tags -1m variants with extra trailing segments", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4.7-1m-internal"),
        "claude-opus-4.7-1m-internal[1m]",
      );
    });

    test("does not tag IDs whose '1m' lacks a leading dash", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude1m-opus"),
        "claude1m-opus",
      );
    });

    test("does not tag plain models", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4-6"),
        "claude-opus-4-6",
      );
    });

    test("is idempotent — does not double-tag", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4-6-1m[1m]"),
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
