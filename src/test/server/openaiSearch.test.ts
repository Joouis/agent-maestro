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
    settings: { external_web_access: true },
    max_output_tokens: 2500,
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

  function postRaw(app: OpenAPIHono, body: string): Promise<Response> {
    return Promise.resolve(
      app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
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
    assert.deepStrictEqual(capturedOptions?.modelOptions, { maxTokens: 2500 });
    const sentinel = capturedOptions?.tools?.[0];
    assert.strictEqual(
      sentinel?.name,
      AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
    );
    assert.deepStrictEqual(
      (sentinel?.inputSchema as any).properties[
        AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER
      ].const,
      { type: "web_search", external_web_access: true },
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
    const operation = document.paths?.["/v1/alpha/search"]?.post;
    assert.ok(operation && "requestBody" in operation);
    assert.ok(operation?.responses?.["200"]);
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
    assert.strictEqual((await response.json()).error.code, "invalid_request");
  });

  test("returns 400 for malformed JSON", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    });

    const response = await postRaw(createApp(model), "{");

    assert.strictEqual(response.status, 400);
    assert.strictEqual((await response.json()).error.code, "invalid_json");
  });

  test("returns 400 for invalid request body shapes", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    });

    for (const body of [
      null,
      [],
      { ...searchRequest, model: 5 },
      { ...searchRequest, input: {} },
      { ...searchRequest, commands: [] },
      { ...searchRequest, settings: "live" },
      {
        ...searchRequest,
        settings: { external_web_access: true, search_context_size: "huge" },
      },
      {
        ...searchRequest,
        settings: { external_web_access: true, user_location: {} },
      },
      {
        ...searchRequest,
        settings: {
          external_web_access: true,
          filters: { allowed_domains: [1] },
        },
      },
      { ...searchRequest, reasoning: { effort: 5 } },
      { ...searchRequest, max_output_tokens: -1 },
    ]) {
      const response = await post(createApp(model), body);

      assert.strictEqual(response.status, 400);
      assert.strictEqual((await response.json()).error.code, "invalid_request");
    }
  });

  test("accepts an empty commands object", async () => {
    const model = createModel(async () => ({
      stream: (async function* () {
        yield new vscode.LanguageModelTextPart("No search command supplied");
      })(),
      text: (async function* () {})(),
    }));

    const response = await post(createApp(model), {
      ...searchRequest,
      commands: {},
    });

    assert.strictEqual(response.status, 200);
  });

  test("requires an explicit external web access mode", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    });

    const response = await post(createApp(model), {
      ...searchRequest,
      settings: {},
    });

    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      (await response.json()).error.code,
      "missing_required_parameter",
    );
  });

  test("accepts the explicit live external web access mode and forwards filters", async () => {
    let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
    const model = createModel(async (_messages, options) => {
      capturedOptions = options;
      return {
        stream: (async function* () {})(),
        text: (async function* () {})(),
      };
    });

    const response = await post(createApp(model), {
      ...searchRequest,
      settings: {
        external_web_access: "live",
        filters: { allowed_domains: ["openai.com"] },
      },
    });

    assert.strictEqual(response.status, 200);
    const sentinel = capturedOptions?.tools?.[0];
    assert.deepStrictEqual(
      (sentinel?.inputSchema as any).properties[
        AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER
      ].const,
      {
        type: "web_search",
        external_web_access: true,
        filters: { allowed_domains: ["openai.com"] },
      },
    );
  });

  test("maps indexed and cached standalone modes to hosted search options", async () => {
    for (const [mode, expected] of [
      ["indexed", { external_web_access: true, indexed_web_access: true }],
      ["cached", { external_web_access: false }],
      [false, { external_web_access: false }],
    ] as const) {
      let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
      const model = createModel(async (_messages, options) => {
        capturedOptions = options;
        return {
          stream: (async function* () {})(),
          text: (async function* () {})(),
        };
      });

      const response = await post(createApp(model), {
        ...searchRequest,
        settings: { external_web_access: mode },
      });

      assert.strictEqual(response.status, 200);
      const sentinel = capturedOptions?.tools?.[0];
      assert.deepStrictEqual(
        (sentinel?.inputSchema as any).properties[
          AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER
        ].const,
        { type: "web_search", ...expected },
      );
    }
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

  test("rejects a GPT-5 request that resolves to an earlier model", async () => {
    const model = createModel(async () => {
      throw new Error("should not send a model request");
    }, "gpt-4.1");

    const response = await post(createApp(model), searchRequest);

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
