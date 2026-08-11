import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerGeminiRoutes } from "../../server/routes/geminiRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import {
  SSE_HEARTBEAT,
  withSseHeartbeat,
} from "../../server/utils/sseHeartbeat";

suite("SSE Heartbeat Test Suite", () => {
  const heartbeatIntervalMs = 5;

  const createDelayedModel = (): vscode.LanguageModelChat =>
    ({
      id: "claude-opus-test",
      name: "Claude Opus Test",
      family: "claude",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: {
        supportsImageToText: false,
        supportsToolCalling: true,
      },
      sendRequest: async () => ({
        stream: (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 25));
          yield new vscode.LanguageModelTextPart("Hello");
        })(),
        text: (async function* () {
          yield "Hello";
        })(),
      }),
      countTokens: async () => 1,
    }) as vscode.LanguageModelChat;

  const createStalledModel = (
    onCancellation: () => void,
  ): vscode.LanguageModelChat =>
    ({
      id: "claude-opus-test",
      name: "Claude Opus Test",
      family: "claude",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: {
        supportsImageToText: false,
        supportsToolCalling: true,
      },
      sendRequest: async (_messages, _options, token) => {
        token?.onCancellationRequested(onCancellation);
        return {
          stream: {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise<
                    IteratorResult<
                      | vscode.LanguageModelTextPart
                      | vscode.LanguageModelToolCallPart
                      | vscode.LanguageModelDataPart
                    >
                  >(() => {}),
              };
            },
          },
          text: (async function* () {})(),
        };
      },
      countTokens: async () => 1,
    }) as vscode.LanguageModelChat;

  test("emits repeated heartbeats without requesting concurrent chunks", async () => {
    let nextCalls = 0;
    let returnCalls = 0;
    const stalledStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextCalls++;
            return new Promise<IteratorResult<string>>(() => {});
          },
          return: async () => {
            returnCalls++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const iterator = withSseHeartbeat(stalledStream, heartbeatIntervalMs);

    assert.strictEqual((await iterator.next()).value, SSE_HEARTBEAT);
    assert.strictEqual((await iterator.next()).value, SSE_HEARTBEAT);
    assert.strictEqual(nextCalls, 1);

    await iterator.return(undefined);
    assert.strictEqual(returnCalls, 1);
  });

  test("passes through immediately available chunks in order", async () => {
    const values: Array<string | typeof SSE_HEARTBEAT> = [];

    for await (const value of withSseHeartbeat(
      (async function* () {
        yield "first";
        yield "second";
      })(),
      heartbeatIntervalMs,
    )) {
      values.push(value);
    }

    assert.deepStrictEqual(values, ["first", "second"]);
  });

  test("writes Anthropic ping events while the model stream is idle", async () => {
    const app = new OpenAPIHono();
    registerAnthropicRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 1000,
      resolveChatModelClient: async () => ({
        client: createDelayedModel(),
      }),
    });

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const body = await response.text();

    assert.match(body, /event: ping\ndata: \{"type":"ping"\}\n\n/);
    assert.ok(body.includes("event: message_stop"));
  });

  test("writes SSE comments for OpenAI Chat Completions", async () => {
    const app = new OpenAPIHono();
    registerOpenaiChatRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 1000,
      resolveChatModelClient: async () => ({
        client: createDelayedModel(),
      }),
    });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const body = await response.text();

    assert.ok(body.includes(": keep-alive\n\n"));
    assert.ok(body.includes("data: [DONE]"));
  });

  test("writes SSE comments for OpenAI Responses", async () => {
    const app = new OpenAPIHono();
    registerOpenaiResponsesRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 1000,
      resolveChatModelClient: async () => ({
        client: createDelayedModel(),
      }),
    });

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        input: "Hello",
        stream: true,
      }),
    });
    const body = await response.text();

    assert.ok(body.includes(": keep-alive\n\n"));
    assert.ok(body.includes("event: response.completed"));
  });

  test("writes SSE comments for Gemini streamGenerateContent", async () => {
    const app = new OpenAPIHono();
    registerGeminiRoutes(app, {
      heartbeatIntervalMs,
      resolveChatModelClient: async () => ({
        client: createDelayedModel(),
      }),
    });

    const response = await app.request(
      "/v1beta/models/claude-opus-test:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    );
    const body = await response.text();

    assert.ok(body.includes(": keep-alive\n\n"));
    assert.ok(body.includes('"finishReason":"STOP"'));
  });

  test("cancels a stalled Gemini stream when its total timeout expires", async () => {
    let cancellationObserved = false;
    const app = new OpenAPIHono();
    registerGeminiRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 25,
      resolveChatModelClient: async () => ({
        client: createStalledModel(() => {
          cancellationObserved = true;
        }),
      }),
    });

    const response = await app.request(
      "/v1beta/models/claude-opus-test:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
      },
    );
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.ok(body.includes('"finishReason":"OTHER"'));
    assert.ok(body.includes("timed out after 25ms"));
    assert.strictEqual(cancellationObserved, true);
  });

  test("cancels a stalled Gemini stream when the client disconnects", async () => {
    let resolveCancellation: (() => void) | undefined;
    const cancellationObserved = new Promise<void>((resolve) => {
      resolveCancellation = resolve;
    });
    const app = new OpenAPIHono();
    registerGeminiRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 1000,
      resolveChatModelClient: async () => ({
        client: createStalledModel(() => resolveCancellation?.()),
      }),
    });
    const clientAbortController = new AbortController();

    const response = await app.request(
      "/v1beta/models/claude-opus-test:streamGenerateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        }),
        signal: clientAbortController.signal,
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    clientAbortController.abort();

    await cancellationObserved;
    const result = await reader.read();
    assert.strictEqual(result.done, true);
  });
});
