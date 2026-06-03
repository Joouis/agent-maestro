import * as assert from "assert";
import * as vscode from "vscode";

import {
  jaccardSimilarity,
  withCopilotContextSize,
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

    test("does not append Claude-specific 1M suffix to non-Claude models", () => {
      assert.strictEqual(
        resolveClaudeCodeModelId("gpt-5.5", "context-1m-2025-08-07"),
        "gpt-5.5",
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
    test("appends [1m] when max input tokens indicate a 1M context window", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4-6", 936000),
        "claude-opus-4-6[1m]",
      );
    });

    test("tags non-Claude 1M-capable models", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("gpt-5.5", 921793),
        "gpt-5.5[1m]",
      );
    });

    test("does not tag models below the 1M context threshold", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4-6", 200000),
        "claude-opus-4-6",
      );
    });

    test("does not tag models above the expected 1M context range", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("future-huge-model", 2_000_000),
        "future-huge-model",
      );
    });

    test("is idempotent — does not double-tag", () => {
      assert.strictEqual(
        withClaudeCode1mSuffix("claude-opus-4-6-1m[1m]", 936000),
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

  suite("withCopilotContextSize", () => {
    test("adds contextSize for Copilot 1M models", () => {
      const model = createMockModel({});
      const result = withCopilotContextSize(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: Record<string, unknown>;
      };

      assert.strictEqual(result.configuration?.contextSize, 936000);
    });

    test("adds contextSize for regular Copilot models", () => {
      const model = createMockModel({
        id: "claude-opus-4.6",
        family: "claude-opus-4.6",
        maxInputTokens: 200000,
      });
      const result = withCopilotContextSize(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: Record<string, unknown>;
      };

      assert.strictEqual(result.configuration?.contextSize, 200000);
    });

    test("does not change non-Copilot models", () => {
      const model = createMockModel({ vendor: "custom" });
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: "test",
      };

      assert.strictEqual(withCopilotContextSize(model, options), options);
    });

    test("does not change models without an advertised input size", () => {
      const model = createMockModel({ maxInputTokens: 0 });
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: "test",
      };

      assert.strictEqual(withCopilotContextSize(model, options), options);
    });

    test("adds contextSize for non-Claude long-context models", () => {
      const model = createMockModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        family: "gpt-5.5",
        maxInputTokens: 921793,
      });
      const result = withCopilotContextSize(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: Record<string, unknown>;
      };

      assert.strictEqual(result.configuration?.contextSize, 921793);
    });

    test("preserves existing private configuration", () => {
      const model = createMockModel({});
      const result = withCopilotContextSize(model, {
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
