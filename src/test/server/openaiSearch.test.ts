import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerOpenaiSearchRoutes } from "../../server/routes/openai/openaiSearchRoutes";
import {
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER,
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
} from "../../utils/copilotWebSearchConstants";

suite("OpenAI Standalone Search Route Test Suite", () => {
  const searchRequest = {
    id: "search-1",
    model: "gpt-5.6-sol",
    input: "Find OpenAI",
    commands: { search_query: [{ q: "OpenAI official site" }] },
  };

  function createModel(
    sendRequest: vscode.LanguageModelChat["sendRequest"],
    family = "gpt-5.6",
  ): vscode.LanguageModelChat {
    return {
      id: family,
      name: family,
      family,
      version: "test",
      vendor: "copilot",
      maxInputTokens: 100000,
      capabilities: { supportsImageToText: true, supportsToolCalling: true },
      sendRequest,
      countTokens: async () => 0,
    } as vscode.LanguageModelChat;
  }

  function createApp(
    model: vscode.LanguageModelChat,
    options: { enabled?: boolean; timeoutMs?: number } = {},
  ): OpenAPIHono {
    const app = new OpenAPIHono();
    registerOpenaiSearchRoutes(app, {
      requestTimeoutMs: options.timeoutMs,
      resolveChatModelClient: async () => ({ client: model }),
      isExperimentalWebSearchEnabled: () => options.enabled ?? true,
    });
    return app;
  }

  function post(app: OpenAPIHono, body: unknown): Promise<Response> {
    return Promise.resolve(
      app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  test("converts a Codex search request into hosted Copilot web search", async () => {
    let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
    const model = createModel(async (_messages, options) => {
      capturedOptions = options;
      return {
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("OpenAI: https://openai.com/");
        })(),
        text: (async function* () {})(),
      };
    });

    const response = await post(createApp(model), searchRequest);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), {
      output: "OpenAI: https://openai.com/",
    });
    assert.strictEqual(
      capturedOptions?.toolMode,
      vscode.LanguageModelChatToolMode.Required,
    );
    const sentinel = capturedOptions?.tools?.[0];
    assert.strictEqual(
      sentinel?.name,
      AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
    );
    assert.deepStrictEqual(
      (sentinel?.inputSchema as any).properties[
        AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER
      ].const,
      { type: "web_search" },
    );
  });

  test("registers the standalone endpoint in OpenAPI", () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    });
    const app = createApp(model);

    const document = app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "test", version: "1" },
    });

    assert.ok(document.paths?.["/v1/alpha/search"]?.post);
  });

  test("rejects standalone search when the experimental patch is disabled", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    });

    const response = await post(
      createApp(model, { enabled: false }),
      searchRequest,
    );

    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      (await response.json()).error.code,
      "web_search_disabled",
    );
  });

  test("rejects requests without commands", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    });

    const response = await post(createApp(model), {
      model: "gpt-5.6-sol",
      input: "Find OpenAI",
    });

    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      (await response.json()).error.code,
      "missing_required_parameter",
    );
  });

  test("rejects non-GPT-5 Copilot models", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    }, "gpt-4.1");

    const response = await post(createApp(model), {
      ...searchRequest,
      model: "gpt-4.1",
    });

    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).error.code, "unsupported_model");
  });

  test("returns 504 and cancels a stalled search", async () => {
    let cancelled = false;
    const model = createModel(async (_messages, _options, token) => {
      token?.onCancellationRequested(() => {
        cancelled = true;
      });
      return new Promise<vscode.LanguageModelChatResponse>(() => {});
    });

    const response = await post(
      createApp(model, { timeoutMs: 20 }),
      searchRequest,
    );

    assert.strictEqual(response.status, 504);
    assert.strictEqual((await response.json()).error.code, "request_timeout");
    assert.strictEqual(cancelled, true);
  });
});
