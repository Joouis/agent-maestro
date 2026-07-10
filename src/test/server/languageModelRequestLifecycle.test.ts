import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  LanguageModelRequestTimeoutError,
  interruptibleLanguageModelStream,
} from "../../server/utils/languageModelRequestLifecycle";

suite("LanguageModelRequestLifecycle Test Suite", () => {
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
        if (token?.isCancellationRequested) {
          onCancellation();
        } else {
          token?.onCancellationRequested(onCancellation);
        }
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
                      | unknown
                    >
                  >(() => {}),
              };
            },
          },
          text: {
            async *[Symbol.asyncIterator]() {},
          },
        };
      },
      countTokens: async () => 0,
    }) as vscode.LanguageModelChat;

  const createAnthropicTestApp = (model: vscode.LanguageModelChat) => {
    const app = new OpenAPIHono();
    registerAnthropicRoutes(app, {
      requestTimeoutMs: 20,
      resolveChatModelClient: async () => ({ client: model }),
    });
    return app;
  };

  const createOpenaiChatTestApp = (model: vscode.LanguageModelChat) => {
    const app = new OpenAPIHono();
    registerOpenaiChatRoutes(app, {
      requestTimeoutMs: 20,
      resolveChatModelClient: async () => ({ client: model }),
    });
    return app;
  };

  const createOpenaiResponsesTestApp = (model: vscode.LanguageModelChat) => {
    const app = new OpenAPIHono();
    registerOpenaiResponsesRoutes(app, {
      requestTimeoutMs: 20,
      resolveChatModelClient: async () => ({ client: model }),
    });
    return app;
  };

  test("cancels a stalled operation when the total timeout expires", async () => {
    const clientAbortController = new AbortController();
    const lifecycle = new LanguageModelRequestLifecycle(
      clientAbortController.signal,
      20,
    );

    await assert.rejects(
      lifecycle.waitFor(new Promise<never>(() => {})),
      LanguageModelRequestTimeoutError,
    );
    assert.strictEqual(lifecycle.token.isCancellationRequested, true);

    lifecycle.dispose();
  });

  test("cancels immediately when the client disconnects", async () => {
    const clientAbortController = new AbortController();
    const lifecycle = new LanguageModelRequestLifecycle(
      clientAbortController.signal,
      1000,
    );

    clientAbortController.abort();

    await assert.rejects(
      lifecycle.waitFor(new Promise<never>(() => {})),
      LanguageModelClientDisconnectedError,
    );
    assert.strictEqual(lifecycle.token.isCancellationRequested, true);

    lifecycle.dispose();
  });

  test("does not cancel a normally completed request", async () => {
    const clientAbortController = new AbortController();
    const lifecycle = new LanguageModelRequestLifecycle(
      clientAbortController.signal,
      1000,
    );

    assert.strictEqual(await lifecycle.waitFor(Promise.resolve(42)), 42);
    lifecycle.dispose();

    assert.strictEqual(lifecycle.token.isCancellationRequested, false);
  });

  test("interrupts an async iterator waiting for its next chunk", async () => {
    const clientAbortController = new AbortController();
    const lifecycle = new LanguageModelRequestLifecycle(
      clientAbortController.signal,
      20,
    );
    const stalledStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
        };
      },
    };
    const iterator = interruptibleLanguageModelStream(stalledStream, lifecycle);

    await assert.rejects(iterator.next(), LanguageModelRequestTimeoutError);

    lifecycle.dispose();
  });

  test("passes through a normally completed async iterator in order", async () => {
    const lifecycle = new LanguageModelRequestLifecycle(
      new AbortController().signal,
      1000,
    );
    const chunks: string[] = [];

    for await (const chunk of interruptibleLanguageModelStream(
      (async function* () {
        yield "first";
        yield "second";
      })(),
      lifecycle,
    )) {
      chunks.push(chunk);
    }

    assert.deepStrictEqual(chunks, ["first", "second"]);
    assert.strictEqual(lifecycle.token.isCancellationRequested, false);
    lifecycle.dispose();
  });

  test("returns a 504 timeout_error for a stalled non-streaming request", async () => {
    let cancellationObserved = false;
    const app = createAnthropicTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );

    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.strictEqual(response.status, 504);
    assert.strictEqual(
      ((await response.json()) as any).error.type,
      "timeout_error",
    );
    assert.strictEqual(cancellationObserved, true);
  });

  test("emits one timeout error without message_stop for a stalled stream", async () => {
    let cancellationObserved = false;
    const app = createAnthropicTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );

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

    assert.strictEqual(response.status, 200);
    assert.strictEqual((body.match(/event: error/g) ?? []).length, 1);
    assert.ok(body.includes('\"type\":\"timeout_error\"'));
    assert.ok(!body.includes("event: message_stop"));
    assert.strictEqual(cancellationObserved, true);
  });

  test("propagates a client disconnect through the Anthropic route", async () => {
    let cancellationObserved = false;
    const app = createAnthropicTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );
    const clientAbortController = new AbortController();

    const responsePromise = app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: clientAbortController.signal,
    });
    clientAbortController.abort();

    const response = await responsePromise;
    assert.strictEqual(response.status, 499);
    assert.strictEqual(cancellationObserved, true);
  });

  test("returns a 504 for a stalled non-streaming Chat Completions request", async () => {
    let cancellationObserved = false;
    const app = createOpenaiChatTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    assert.strictEqual(response.status, 504);
    assert.strictEqual(
      ((await response.json()) as any).error.code,
      "request_timeout",
    );
    assert.strictEqual(cancellationObserved, true);
  });

  test("emits one error without a successful Chat Completions terminator", async () => {
    let cancellationObserved = false;
    const app = createOpenaiChatTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );

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

    assert.strictEqual(response.status, 200);
    assert.strictEqual((body.match(/event: error/g) ?? []).length, 1);
    assert.ok(body.includes("request_timeout"));
    assert.ok(!body.includes("data: [DONE]"));
    assert.ok(!body.includes('\"finish_reason\":\"stop\"'));
    assert.strictEqual(cancellationObserved, true);
  });

  test("propagates a client disconnect through Chat Completions", async () => {
    let cancellationObserved = false;
    const app = createOpenaiChatTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );
    const clientAbortController = new AbortController();

    const responsePromise = app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: clientAbortController.signal,
    });
    clientAbortController.abort();

    const response = await responsePromise;
    assert.strictEqual(response.status, 499);
    assert.strictEqual(cancellationObserved, true);
  });

  test("returns a 504 for a stalled non-streaming Responses request", async () => {
    let cancellationObserved = false;
    const app = createOpenaiResponsesTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        input: "Hello",
      }),
    });

    assert.strictEqual(response.status, 504);
    assert.strictEqual(
      ((await response.json()) as any).error.code,
      "request_timeout",
    );
    assert.strictEqual(cancellationObserved, true);
  });

  test("emits one response.failed without response.completed", async () => {
    let cancellationObserved = false;
    const app = createOpenaiResponsesTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );

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

    assert.strictEqual(response.status, 200);
    assert.strictEqual((body.match(/event: response.failed/g) ?? []).length, 1);
    assert.ok(body.includes("request_timeout"));
    assert.ok(!body.includes("event: response.completed"));
    assert.strictEqual(cancellationObserved, true);
  });

  test("propagates a client disconnect through Responses", async () => {
    let cancellationObserved = false;
    const app = createOpenaiResponsesTestApp(
      createStalledModel(() => {
        cancellationObserved = true;
      }),
    );
    const clientAbortController = new AbortController();

    const responsePromise = app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-test",
        input: "Hello",
      }),
      signal: clientAbortController.signal,
    });
    clientAbortController.abort();

    const response = await responsePromise;
    assert.strictEqual(response.status, 499);
    assert.strictEqual(cancellationObserved, true);
  });
});
