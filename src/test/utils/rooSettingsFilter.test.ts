import * as assert from "assert";

import { filterRooSettings } from "../../utils/rooSettingsFilter";

suite("RooSettingsFilter Test Suite", () => {
  suite("filterRooSettings", () => {
    test("should remove API keys from settings", () => {
      const settings = {
        apiKey: "secret-api-key",
        openAiApiKey: "openai-secret",
        geminiApiKey: "gemini-secret",
        deepSeekApiKey: "deepseek-secret",
        mistralApiKey: "mistral-secret",
        groqApiKey: "groq-secret",
        xaiApiKey: "xai-secret",
        openRouterApiKey: "openrouter-secret",
        glamaApiKey: "glama-secret",
        unboundApiKey: "unbound-secret",
        requestyApiKey: "requesty-secret",
        chutesApiKey: "chutes-secret",
        litellmApiKey: "litellm-secret",
        openAiNativeApiKey: "openai-native-secret",
        awsAccessKey: "aws-access-key",
        awsSecretKey: "aws-secret-key",
        awsSessionToken: "aws-session-token",
        // Non-secret fields that should be preserved
        apiProvider: "anthropic",
        customInstructions: "Be helpful",
        mode: "code",
      } as any;

      const filtered = filterRooSettings(settings);

      // Verify all secrets are removed
      assert.strictEqual(filtered.apiKey, undefined);
      assert.strictEqual(filtered.openAiApiKey, undefined);
      assert.strictEqual(filtered.geminiApiKey, undefined);
      assert.strictEqual(filtered.deepSeekApiKey, undefined);
      assert.strictEqual(filtered.mistralApiKey, undefined);
      assert.strictEqual(filtered.groqApiKey, undefined);
      assert.strictEqual(filtered.xaiApiKey, undefined);
      assert.strictEqual(filtered.openRouterApiKey, undefined);
      assert.strictEqual(filtered.glamaApiKey, undefined);
      assert.strictEqual(filtered.unboundApiKey, undefined);
      assert.strictEqual(filtered.requestyApiKey, undefined);
      assert.strictEqual(filtered.chutesApiKey, undefined);
      assert.strictEqual(filtered.litellmApiKey, undefined);
      assert.strictEqual(filtered.openAiNativeApiKey, undefined);
      assert.strictEqual(filtered.awsAccessKey, undefined);
      assert.strictEqual(filtered.awsSecretKey, undefined);
      assert.strictEqual(filtered.awsSessionToken, undefined);

      // Verify non-secret fields are preserved
      assert.strictEqual((filtered as any).apiProvider, "anthropic");
      assert.strictEqual((filtered as any).customInstructions, "Be helpful");
      assert.strictEqual((filtered as any).mode, "code");
    });

    test("should remove taskHistory from settings", () => {
      const settings = {
        taskHistory: [
          { id: "task-1", task: "Do something" },
          { id: "task-2", task: "Do something else" },
        ],
        apiProvider: "openai",
      } as any;

      const filtered = filterRooSettings(settings);

      assert.strictEqual((filtered as any).taskHistory, undefined);
      assert.strictEqual((filtered as any).apiProvider, "openai");
    });

    test("should return empty-like object for empty settings", () => {
      const settings = {} as any;
      const filtered = filterRooSettings(settings);

      assert.ok(typeof filtered === "object");
      assert.strictEqual(Object.keys(filtered).length, 0);
    });

    test("should preserve all non-sensitive settings", () => {
      const settings = {
        apiProvider: "anthropic",
        customInstructions: "Test instructions",
        mode: "code",
        autoApprove: true,
        browserEnabled: false,
        maxOpenTabs: 10,
        soundEnabled: true,
        preferredLanguage: "typescript",
      } as any;

      const filtered = filterRooSettings(settings);

      // All fields should be preserved since none are secrets
      assert.strictEqual((filtered as any).apiProvider, "anthropic");
      assert.strictEqual(
        (filtered as any).customInstructions,
        "Test instructions",
      );
      assert.strictEqual((filtered as any).mode, "code");
      assert.strictEqual((filtered as any).autoApprove, true);
      assert.strictEqual((filtered as any).browserEnabled, false);
      assert.strictEqual((filtered as any).maxOpenTabs, 10);
      assert.strictEqual((filtered as any).soundEnabled, true);
      assert.strictEqual((filtered as any).preferredLanguage, "typescript");
    });

    test("should not modify the original settings object", () => {
      const originalSettings = {
        apiKey: "secret-key",
        apiProvider: "anthropic",
      } as any;

      // Create a reference to check
      const originalApiKey = originalSettings.apiKey;

      filterRooSettings(originalSettings);

      // Original should remain unchanged
      assert.strictEqual(originalSettings.apiKey, originalApiKey);
      assert.strictEqual(originalSettings.apiProvider, "anthropic");
    });
  });
});
