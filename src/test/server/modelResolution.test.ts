import * as assert from "assert";
import * as vscode from "vscode";

import {
  jaccardSimilarity,
  withCopilotLongContextConfiguration,
} from "../../utils/chatModels";
import {
  resolveClaudeCodeModelId,
  withClaudeCode1mSuffix,
} from "../../utils/claude";

suite("Model Resolution Test Suite", () => {
  function createMockModel(
    overrides: Partial<vscode.LanguageModelChat>,
  ): vscode.LanguageModelChat {
    return {
      id: "claude-opus-4.6-1m",
      name: "Claude Opus 4.6 (1M context)",
      family: "claude-opus-4.6-1m",
      version: "4.6",
      vendor: "copilot",
      maxInputTokens: 936000,
      capabilities: {},
      sendRequest: async () => {
        throw new Error("not implemented");
      },
      countTokens: async () => 0,
      ...overrides,
    } as vscode.LanguageModelChat;
  }

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
      assert.strictEqual(
        resolveClaudeCodeModelId(
          "claude-opus-4.7-1m-internal[1m]",
          "context-1m-2025-08-07",
        ),
        "claude-opus-4.7-1m-internal[1m]",
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

  suite("withCopilotLongContextConfiguration", () => {
    test("adds contextSize for Copilot 1M models", () => {
      const model = createMockModel({});
      const result = withCopilotLongContextConfiguration(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: Record<string, unknown>;
      };

      assert.strictEqual(result.configuration?.contextSize, 936000);
    });

    test("does not change regular Copilot models", () => {
      const model = createMockModel({
        id: "claude-opus-4.6",
        family: "claude-opus-4.6",
        maxInputTokens: 200000,
      });
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: "test",
      };

      assert.strictEqual(
        withCopilotLongContextConfiguration(model, options),
        options,
      );
    });

    test("does not change non-Claude 1M models", () => {
      const model = createMockModel({
        id: "gemini-3.5-flash-1m",
        name: "Gemini 3.5 Flash 1M",
        family: "gemini",
      });
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: "test",
      };

      assert.strictEqual(
        withCopilotLongContextConfiguration(model, options),
        options,
      );
    });

    test("preserves existing private configuration", () => {
      const model = createMockModel({});
      const result = withCopilotLongContextConfiguration(model, {
        justification: "test",
        configuration: { reasoningEffort: "high" },
      } as vscode.LanguageModelChatRequestOptions & {
        configuration: Record<string, unknown>;
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: Record<string, unknown>;
      };

      assert.strictEqual(result.configuration?.contextSize, 936000);
      assert.strictEqual(result.configuration?.reasoningEffort, "high");
    });
  });
});
