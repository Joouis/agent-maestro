import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import OpenAI from "openai";
import * as vscode from "vscode";

import type { ExtensionController } from "../../core/controller";
import { ProxyServer } from "../../server/ProxyServer";
import { registerOpenaiModelsRoutes } from "../../server/routes/openai/openaiModelsRoutes";
import { registerOpenaiRoutes } from "../../server/routes/openai/openaiRoutes";
import {
  chatModelsCache,
  getChatModelsQuickPickItems,
} from "../../utils/chatModels";

const mockModel = (id: string, family = id): vscode.LanguageModelChat => ({
  id,
  family,
  name: id,
  vendor: "copilot",
  version: "test",
  maxInputTokens: 400000,
  countTokens: async () => 1,
  sendRequest: async () => {
    throw new Error("Discovery must not generate output");
  },
});

suite("OpenAI Model Discovery Test Suite", () => {
  const createApp = (
    getChatModels: () => Promise<vscode.LanguageModelChat[]>,
  ) => {
    const app = new OpenAPIHono();
    registerOpenaiModelsRoutes(app, { getChatModels });
    return app;
  };
  const clientFor = (app: OpenAPIHono, apiKey = "test") =>
    new OpenAI({
      apiKey,
      baseURL: "http://localhost/v1",
      maxRetries: 0,
      fetch: async (input, init) => app.request(new Request(input, init)),
    });

  test("official SDK lists and retrieves every available model family", async () => {
    const models = ["gpt-test", "claude-test", "gemini-test", "grok-test"].map(
      (id) => mockModel(id),
    );
    const client = clientFor(createApp(async () => models));
    const listed = await client.models.list();
    assert.strictEqual(listed.object, "list");
    assert.deepStrictEqual(
      listed.data.map((model) => model.id),
      models.map((model) => model.id),
    );
    for (const model of listed.data) {
      assert.deepStrictEqual(model, {
        id: model.id,
        object: "model",
        created: 0,
        owned_by: "copilot",
      });
      assert.deepStrictEqual(await client.models.retrieve(model.id), model);
    }
  });

  test("returns an empty list when no models are available", async () => {
    const result = await clientFor(createApp(async () => [])).models.list();
    assert.deepStrictEqual(result.data, []);
  });

  test("retrieval is exact and never falls back to another model", async () => {
    const client = clientFor(
      createApp(async () => [mockModel("grok-test"), mockModel("auto")]),
    );
    for (const id of ["GROK-test", "grok-typo", "missing"]) {
      await assert.rejects(client.models.retrieve(id), (error: unknown) => {
        assert.ok(error instanceof OpenAI.NotFoundError);
        assert.strictEqual(error.code, "model_not_found");
        assert.strictEqual(error.param, "model");
        return true;
      });
    }
  });

  test("protects both discovery routes with the existing Bearer authentication", async () => {
    const original = chatModelsCache.getChatModels;
    let queries = 0;
    try {
      chatModelsCache.getChatModels = async () => {
        queries++;
        return [mockModel("grok-test")];
      };
      const proxy = new ProxyServer(
        {} as ExtensionController,
        23333,
        {} as vscode.ExtensionContext,
      );
      proxy.setLlmApiKey("server-key");
      const app = (proxy as unknown as { app: OpenAPIHono }).app;
      for (const route of [
        "/api/openai/v1/models",
        "/api/openai/v1/models/grok-test",
      ]) {
        for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<
          string,
          string
        >[]) {
          assert.strictEqual(
            (await app.request(route, { headers })).status,
            401,
          );
        }
      }
      assert.strictEqual(queries, 0);
      const client = new OpenAI({
        apiKey: "server-key",
        baseURL: "http://localhost/api/openai/v1",
        maxRetries: 0,
        fetch: async (input, init) => app.request(new Request(input, init)),
      });
      assert.strictEqual((await client.models.list()).data[0].id, "grok-test");
      assert.strictEqual(
        (await client.models.retrieve("grok-test")).id,
        "grok-test",
      );
      assert.strictEqual(queries, 2);
    } finally {
      chatModelsCache.getChatModels = original;
    }
  });

  test("discovers a Grok-only Copilot account without requiring Claude or exposing other vendors", async () => {
    const originalSelect = vscode.lm.selectChatModels;
    const previousModels = chatModelsCache.getCachedModels();
    const originalWarning = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    try {
      vscode.lm.selectChatModels = async () => [
        mockModel("grok-test"),
        { ...mockModel("private-model"), vendor: "custom" },
      ];
      vscode.window.showWarningMessage = (async (message: string) => {
        warnings.push(message);
        return undefined;
      }) as typeof vscode.window.showWarningMessage;
      await chatModelsCache.refresh();
      const app = new OpenAPIHono();
      registerOpenaiRoutes(app);
      assert.deepStrictEqual(
        (await clientFor(app).models.list()).data.map((model) => model.id),
        ["grok-test"],
      );
      assert.deepStrictEqual(warnings, []);
    } finally {
      vscode.lm.selectChatModels = async () => previousModels;
      await chatModelsCache.refresh();
      vscode.lm.selectChatModels = originalSelect;
      vscode.window.showWarningMessage = originalWarning;
    }
  });

  test("groups Grok models independently of the selected client protocol", async () => {
    const original = chatModelsCache.getChatModels;
    try {
      chatModelsCache.getChatModels = async () => [
        mockModel("gpt-test", "gpt"),
        mockModel("grok-1", "grok"),
        mockModel("grok-2", "grok"),
      ];
      const choices = await getChatModelsQuickPickItems({
        priorityFamily: "grok",
      });
      assert.strictEqual(choices[0].label, "Grok");
      assert.deepStrictEqual(
        choices.slice(1, 3).map((choice) => choice.modelId),
        ["grok-2", "grok-1"],
      );
      const recommended = await getChatModelsQuickPickItems({
        recommendedModelId: "grok-1",
      });
      assert.strictEqual(recommended[0].label, "Recommended");
      assert.strictEqual(
        recommended.filter((choice) => choice.modelId === "grok-1").length,
        1,
      );
    } finally {
      chatModelsCache.getChatModels = original;
    }
  });

  test("the default discovery path reports VS Code failures while generation retains its existing fallback behavior", async () => {
    const originalSelect = vscode.lm.selectChatModels;
    const previousModels = chatModelsCache.getCachedModels();
    try {
      vscode.lm.selectChatModels = async () => {
        throw new Error("private provider detail");
      };
      await chatModelsCache.refresh();
      const app = new OpenAPIHono();
      registerOpenaiRoutes(app);
      for (const route of ["/v1/models", "/v1/models/grok-test"]) {
        const response = await app.request(route);
        assert.strictEqual(response.status, 500);
        const body = await response.text();
        assert.strictEqual(JSON.parse(body).error.type, "api_error");
        assert.ok(!body.includes("private provider detail"));
      }
      assert.deepStrictEqual(await chatModelsCache.getChatModels(), []);
      vscode.lm.selectChatModels = async () => [mockModel("grok-recovered")];
      assert.strictEqual(
        (await clientFor(app).models.list()).data[0].id,
        "grok-recovered",
      );
    } finally {
      vscode.lm.selectChatModels = async () => previousModels;
      await chatModelsCache.refresh();
      vscode.lm.selectChatModels = originalSelect;
    }
  });
});
