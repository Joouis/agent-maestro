import * as assert from "assert";
import * as vscode from "vscode";

import {
  type CopilotModelConfiguration,
  chatModelsCache,
  getChatModelClient,
  getCopilotModelConfiguration,
  jaccardSimilarity,
  withCopilotConfiguration,
} from "../../utils/chatModels";
import { withClaudeCode1mSuffix } from "../../utils/claude";

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

  suite("getChatModelClient fallback", () => {
    test("uses configured, auto, then first-available fallback models", async () => {
      const configured = createMockModel({
        id: "gpt-5.6-sol",
        version: "5.6",
      });
      const sameVersionAsAuto = createMockModel({
        id: "another-model",
        version: "auto-version",
      });
      const auto = createMockModel({ id: "auto", version: "auto-version" });
      const configuration = vscode.workspace.getConfiguration("agent-maestro");
      const previousFallbackModelId =
        configuration.inspect<string>("fallbackModelId")?.globalValue;
      const originalGetChatModels = chatModelsCache.getChatModels;

      try {
        chatModelsCache.getChatModels = async () => [
          sameVersionAsAuto,
          configured,
          auto,
        ];
        await configuration.update(
          "fallbackModelId",
          configured.id,
          vscode.ConfigurationTarget.Global,
        );
        assert.strictEqual(
          (await getChatModelClient("codex-auto-review")).client,
          configured,
        );

        await configuration.update(
          "fallbackModelId",
          "missing-model",
          vscode.ConfigurationTarget.Global,
        );
        assert.strictEqual(
          (await getChatModelClient("codex-auto-review")).client,
          auto,
        );

        await configuration.update(
          "fallbackModelId",
          undefined,
          vscode.ConfigurationTarget.Global,
        );
        chatModelsCache.getChatModels = async () => [
          sameVersionAsAuto,
          configured,
        ];
        assert.strictEqual(
          (await getChatModelClient("codex-auto-review")).client,
          sameVersionAsAuto,
        );
      } finally {
        chatModelsCache.getChatModels = originalGetChatModels;
        await configuration.update(
          "fallbackModelId",
          previousFallbackModelId,
          vscode.ConfigurationTarget.Global,
        );
      }
    });
  });

  suite("withCopilotConfiguration", () => {
    test("adds contextSize for Copilot 1M models", () => {
      const model = createMockModel({});
      const result = withCopilotConfiguration(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: CopilotModelConfiguration;
      };

      assert.strictEqual(result.configuration?.contextSize, 936000);
    });

    test("adds contextSize for regular Copilot models", () => {
      const model = createMockModel({
        id: "claude-opus-4.6",
        family: "claude-opus-4.6",
        maxInputTokens: 200000,
      });
      const result = withCopilotConfiguration(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: CopilotModelConfiguration;
      };

      assert.strictEqual(result.configuration?.contextSize, 200000);
    });

    test("does not change non-Copilot models", () => {
      const model = createMockModel({ vendor: "custom" });
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: "test",
      };

      assert.strictEqual(withCopilotConfiguration(model, options), options);
    });

    test("does not change models without an advertised input size", () => {
      const model = createMockModel({ maxInputTokens: 0 });
      const options: vscode.LanguageModelChatRequestOptions = {
        justification: "test",
      };

      assert.strictEqual(withCopilotConfiguration(model, options), options);
    });

    test("adds contextSize for non-Claude long-context models", () => {
      const model = createMockModel({
        id: "gpt-5.5",
        name: "GPT-5.5",
        family: "gpt-5.5",
        maxInputTokens: 921793,
      });
      const result = withCopilotConfiguration(model, {
        justification: "test",
      }) as vscode.LanguageModelChatRequestOptions & {
        configuration?: CopilotModelConfiguration;
      };

      assert.strictEqual(result.configuration?.contextSize, 921793);
    });

    test("merges request-specific Copilot configuration", () => {
      const model = createMockModel({});
      const result = withCopilotConfiguration(
        model,
        { justification: "test" },
        { reasoningEffort: "medium" },
      ) as vscode.LanguageModelChatRequestOptions & {
        configuration?: CopilotModelConfiguration;
      };

      assert.strictEqual(result.configuration?.contextSize, 936000);
      assert.strictEqual(result.configuration?.reasoningEffort, "medium");
    });
  });

  suite("getCopilotModelConfiguration", () => {
    test("extracts reasoningEffort from a non-empty string", () => {
      assert.deepStrictEqual(
        getCopilotModelConfiguration({ reasoningEffort: " high " }),
        { reasoningEffort: "high" },
      );
    });

    test("ignores missing or non-string reasoning effort values", () => {
      assert.deepStrictEqual(getCopilotModelConfiguration({}), {});
      assert.deepStrictEqual(
        getCopilotModelConfiguration({ reasoningEffort: 1 }),
        {},
      );
    });
  });
});
