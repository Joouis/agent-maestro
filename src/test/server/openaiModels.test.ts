import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import OpenAI from "openai";
import * as vscode from "vscode";

import type { ExtensionController } from "../../core/controller";
import { ProxyServer } from "../../server/ProxyServer";
import { registerOpenaiModelsRoutes } from "../../server/routes/openai/openaiModelsRoutes";
import { registerOpenaiRoutes } from "../../server/routes/openai/openaiRoutes";
import { chatModelsCache } from "../../utils/chatModels";

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
  const originalGetChatModels = chatModelsCache.getChatModels;
  const originalSelectChatModels = vscode.lm.selectChatModels;
  const originalShowWarningMessage = vscode.window.showWarningMessage;
  let previousModels: vscode.LanguageModelChat[] = [];

  setup(() => {
    previousModels = chatModelsCache.getCachedModels();
  });

  teardown(async () => {
    chatModelsCache.getChatModels = originalGetChatModels;
    vscode.window.showWarningMessage = originalShowWarningMessage;
    vscode.lm.selectChatModels = async () => previousModels;
    await chatModelsCache.refresh();
    vscode.lm.selectChatModels = originalSelectChatModels;
  });

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
    let queries = 0;
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
        assert.strictEqual((await app.request(route, { headers })).status, 401);
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
  });

  test("exposes only copilot-vendor models from the shared cache", async () => {
    vscode.window.showWarningMessage = (async () =>
      undefined) as typeof vscode.window.showWarningMessage;
    vscode.lm.selectChatModels = async () => [
      mockModel("claude-test"),
      { ...mockModel("private-model"), vendor: "custom" },
    ];
    await chatModelsCache.refresh();
    const app = new OpenAPIHono();
    registerOpenaiRoutes(app);
    const listed = await clientFor(app).models.list();
    assert.deepStrictEqual(listed.data, [
      {
        id: "claude-test",
        object: "model",
        created: 0,
        owned_by: "copilot",
      },
    ]);
  });

  test("the default discovery path reports VS Code failures while generation retains its existing fallback behavior", async () => {
    vscode.window.showWarningMessage = (async () =>
      undefined) as typeof vscode.window.showWarningMessage;
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
      assert.strictEqual(JSON.parse(body).error.type, "internal_error");
      assert.ok(!body.includes("private provider detail"));
    }
    assert.deepStrictEqual(await chatModelsCache.getChatModels(), []);
    vscode.lm.selectChatModels = async () => [mockModel("claude-recovered")];
    assert.strictEqual(
      (await clientFor(app).models.list()).data[0].id,
      "claude-recovered",
    );
  });

  test("isolates discovery errors per initialization run when refresh overlaps", async () => {
    vscode.window.showWarningMessage = (async () =>
      undefined) as typeof vscode.window.showWarningMessage;
    vscode.lm.selectChatModels = async () => [];
    await chatModelsCache.refresh();

    let rejectFirstRun!: (error: Error) => void;
    let firstRunStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstRunStarted = resolve;
    });
    let callCount = 0;
    vscode.lm.selectChatModels = () => {
      callCount++;
      if (callCount === 1) {
        firstRunStarted();
        return new Promise<vscode.LanguageModelChat[]>((_, reject) => {
          rejectFirstRun = reject;
        });
      }
      return Promise.resolve([mockModel("claude-refreshed")]);
    };

    const firstCall = chatModelsCache.getChatModels({ throwOnError: true });
    await firstStarted;

    await chatModelsCache.refresh();
    assert.deepStrictEqual(
      (await chatModelsCache.getChatModels({ throwOnError: true })).map(
        (model) => model.id,
      ),
      ["claude-refreshed"],
    );

    rejectFirstRun(new Error("first run failed"));
    await assert.rejects(firstCall, /first run failed/);
    assert.deepStrictEqual(
      (await chatModelsCache.getChatModels({ throwOnError: true })).map(
        (model) => model.id,
      ),
      ["claude-refreshed"],
    );

    vscode.lm.selectChatModels = async () => [];
    await chatModelsCache.refresh();

    let resolveSlowSuccess!: (models: vscode.LanguageModelChat[]) => void;
    let slowStarted!: () => void;
    const slowRunStarted = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    callCount = 0;
    vscode.lm.selectChatModels = () => {
      callCount++;
      if (callCount === 1) {
        slowStarted();
        return new Promise<vscode.LanguageModelChat[]>((resolve) => {
          resolveSlowSuccess = resolve;
        });
      }
      return Promise.reject(new Error("refresh failed"));
    };

    const succeedingCall = chatModelsCache.getChatModels({
      throwOnError: true,
    });
    await slowRunStarted;
    await chatModelsCache.refresh();

    resolveSlowSuccess([mockModel("claude-first")]);
    assert.deepStrictEqual(
      (await succeedingCall).map((model) => model.id),
      ["claude-first"],
    );
    assert.deepStrictEqual(chatModelsCache.getCachedModels(), []);
  });
});
