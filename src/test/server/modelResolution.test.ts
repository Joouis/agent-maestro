import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerGeminiRoutes } from "../../server/routes/geminiRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import {
  type CopilotModelConfiguration,
  chatModelsCache,
  getChatModelClient,
  getCopilotModelConfiguration,
  jaccardSimilarity,
  withCopilotConfiguration,
  withCopilotConversationId,
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

  suite("withCopilotConversationId", () => {
    test("maps prompt_cache_key to Copilot _conversationId", () => {
      assert.deepStrictEqual(
        withCopilotConversationId({ temperature: 1 }, "session-1 "),
        { temperature: 1, _conversationId: "session-1 " },
      );
    });

    test("ignores missing, empty, or non-string cache keys", () => {
      assert.deepStrictEqual(withCopilotConversationId({}, undefined), {});
      assert.deepStrictEqual(withCopilotConversationId({}, "  "), {});
      assert.deepStrictEqual(withCopilotConversationId({}, 42), {});
    });
  });

  suite("resolved model id in responses", () => {
    const requestedModelId = "gpt-unknown";
    const resolvedModel = {
      id: "gpt-resolved",
      name: "GPT Resolved",
      family: "gpt",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: false, supportsToolCalling: true },
      sendRequest: async () => ({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("ok");
        })(),
        text: (async function* () {
          yield "ok";
        })(),
      }),
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;

    const createApp = () => {
      const app = new OpenAPIHono();
      const options = {
        resolveChatModelClient: async () => ({ client: resolvedModel }),
      };
      registerAnthropicRoutes(app, options);
      registerGeminiRoutes(app, options);
      registerOpenaiChatRoutes(app, options);
      registerOpenaiResponsesRoutes(app, options);
      return app;
    };

    const post = (path: string, body: Record<string, unknown>) =>
      createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const parseSseData = (body: string): Record<string, any>[] =>
      body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));

    const anthropicBody = {
      model: requestedModelId,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    };
    const chatBody = {
      model: requestedModelId,
      messages: [{ role: "user", content: "hi" }],
    };
    const responsesBody = { model: requestedModelId, input: "hi" };
    const geminiBody = {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    };

    test("Anthropic messages report the resolved model", async () => {
      const response = await post("/v1/messages", anthropicBody);
      const body = (await response.json()) as Record<string, any>;
      assert.strictEqual(body.model, resolvedModel.id);

      const stream = await post("/v1/messages", {
        ...anthropicBody,
        stream: true,
      });
      const start = parseSseData(await stream.text()).find(
        (event) => event.type === "message_start",
      );
      assert.strictEqual(start?.message.model, resolvedModel.id);
    });

    test("OpenAI chat completions report the resolved model", async () => {
      const response = await post("/v1/chat/completions", chatBody);
      const body = (await response.json()) as Record<string, any>;
      assert.strictEqual(body.model, resolvedModel.id);

      const stream = await post("/v1/chat/completions", {
        ...chatBody,
        stream: true,
      });
      const chunks = parseSseData(await stream.text());
      assert.ok(chunks.length > 0);
      assert.ok(chunks.every((chunk) => chunk.model === resolvedModel.id));
    });

    test("OpenAI responses report the resolved model", async () => {
      const response = await post("/v1/responses", responsesBody);
      const body = (await response.json()) as Record<string, any>;
      assert.strictEqual(body.model, resolvedModel.id);

      const stream = await post("/v1/responses", {
        ...responsesBody,
        stream: true,
      });
      const envelopes = parseSseData(await stream.text())
        .map((event) => event.response)
        .filter(Boolean);
      assert.ok(envelopes.length > 0);
      assert.ok(envelopes.every((r) => r.model === resolvedModel.id));
    });

    test("Gemini generateContent reports the resolved model", async () => {
      const response = await post(
        `/v1beta/models/${requestedModelId}:generateContent`,
        geminiBody,
      );
      const body = (await response.json()) as Record<string, any>;
      assert.strictEqual(body.modelVersion, resolvedModel.id);

      const stream = await post(
        `/v1beta/models/${requestedModelId}:streamGenerateContent?alt=sse`,
        geminiBody,
      );
      const chunks = parseSseData(await stream.text());
      assert.strictEqual(chunks.at(-1)?.modelVersion, resolvedModel.id);
    });
  });
});
