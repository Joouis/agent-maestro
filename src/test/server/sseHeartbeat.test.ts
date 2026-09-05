import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import OpenAI from "openai";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerGeminiRoutes } from "../../server/routes/geminiRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import { withOpenAIResponsesHeartbeat } from "../../server/utils/openaiResponses";
import {
  SSE_HEARTBEAT,
  withSseHeartbeat,
} from "../../server/utils/sseHeartbeat";

suite("SSE Heartbeat Test Suite", () => {
  const heartbeatIntervalMs = 5;

  const parseResponsesEvents = (body: string): Record<string, any>[] =>
    body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));

  const assertResponseSequence = (
    events: Record<string, any>[],
    terminalType: string,
  ) => {
    assert.strictEqual(events[0].type, "response.created");
    assert.strictEqual(events.at(-1)?.type, terminalType);
    assert.deepStrictEqual(
      events.map(({ sequence_number }) => sequence_number),
      events.map((_, index) => index),
    );
    assert.ok(
      events
        .filter(({ response }) => response)
        .every(({ response }) => response.id === events[0].response.id),
    );
  };

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  const responsesRequest = (
    model: vscode.LanguageModelChat,
    signal?: AbortSignal,
    requestTimeoutMs = 1000,
  ) => {
    const app = new OpenAPIHono();
    registerOpenaiResponsesRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs,
      resolveChatModelClient: async () => ({ client: model }),
    });
    return app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        input: "Hello",
        stream: true,
      }),
      signal,
    });
  };

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

  test("writes parsed JSON heartbeats for OpenAI Responses", async () => {
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

    const events = parseResponsesEvents(body);
    const heartbeats = events.filter(({ type }) => type === "keepalive");
    assert.ok(heartbeats.length > 0);
    assert.ok(heartbeats.every((event) => !("response" in event)));
    assert.strictEqual(
      events.filter(({ type }) => type === "response.in_progress").length,
      1,
    );
    assert.ok(body.includes("event: keepalive\n"));
    assertResponseSequence(events, "response.completed");
    assert.ok(!body.includes(": keep-alive"));
  });

  test("keeps Responses alive during startup, ignored chunks, and token counting", async () => {
    const startup = deferred();
    const counting = deferred();
    const controller = new AbortController();
    let stage = "startup";
    let ignoredChunks = 0;
    const model: vscode.LanguageModelChat = {
      ...createDelayedModel(),
      sendRequest: async () => {
        await startup.promise;
        return {
          stream: (async function* () {
            stage = "ignored";
            while (stage === "ignored") {
              await new Promise((resolve) => setTimeout(resolve, 1));
              ignoredChunks++;
              yield new vscode.LanguageModelDataPart(
                new Uint8Array(),
                "ignored",
              );
            }
            yield new vscode.LanguageModelTextPart("Hello");
          })(),
          text: (async function* () {})(),
        };
      },
      countTokens: async () => {
        stage = "counting";
        await counting.promise;
        return 1;
      },
    };
    // A missing heartbeat leaves a stage blocked until the request fails.
    const response = await responsesRequest(model, controller.signal);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const heartbeatStages = new Set<string>();
    let body = "";
    let pending = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = decoder.decode(value, { stream: true });
        body += text;
        pending += text;
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) !== -1) {
          const [event] = parseResponsesEvents(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
          if (event?.type !== "keepalive") {
            continue;
          }
          heartbeatStages.add(stage);
          if (stage === "startup") {
            startup.resolve();
          } else if (stage === "ignored" && ignoredChunks > 0) {
            stage = "output";
          } else if (stage === "counting") {
            counting.resolve();
          }
        }
      }
      assert.deepStrictEqual(
        [...heartbeatStages],
        ["startup", "ignored", "counting"],
      );
      assert.ok(ignoredChunks > 0);
      assertResponseSequence(parseResponsesEvents(body), "response.completed");
    } finally {
      controller.abort();
      stage = "done";
      startup.resolve();
      counting.resolve();
      reader.releaseLock();
    }
  });

  test("preserves OpenAI SDK text snapshots across heartbeats between deltas", async () => {
    const nextDelta = deferred();
    const tokenCounts = deferred();
    const controller = new AbortController();
    let stage = "text";
    const model: vscode.LanguageModelChat = {
      ...createDelayedModel(),
      sendRequest: async () => ({
        stream: (async function* () {
          yield new vscode.LanguageModelTextPart("Hello ");
          await nextDelta.promise;
          yield new vscode.LanguageModelTextPart("world");
        })(),
        text: (async function* () {})(),
      }),
      countTokens: async () => {
        stage = "counting";
        await tokenCounts.promise;
        return 1;
      },
    };
    const client = new OpenAI({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () => responsesRequest(model, controller.signal),
    });
    const stream = client.responses.stream({ model: model.id, input: "Hello" });
    const events: Record<string, any>[] = [];
    const snapshots: string[] = [];
    const heartbeatStages = new Set<string>();
    stream.on("response.output_text.delta", ({ snapshot }) => {
      snapshots.push(snapshot);
    });
    stream.on("event", (event) => {
      events.push(event);
      if ((event as { type: string }).type !== "keepalive") {
        return;
      }
      heartbeatStages.add(stage);
      if (stage === "text" && snapshots.length > 0) {
        nextDelta.resolve();
      } else if (stage === "counting") {
        tokenCounts.resolve();
      }
    });
    try {
      const response = await stream.finalResponse();
      assert.deepStrictEqual(snapshots, ["Hello ", "Hello world"]);
      assert.deepStrictEqual([...heartbeatStages], ["text", "counting"]);
      assert.strictEqual(response.output_text, "Hello world");
      assert.strictEqual(response.output.length, 1);
      assertResponseSequence(events, "response.completed");
      const firstDelta = events.findIndex(
        ({ type }) => type === "response.output_text.delta",
      );
      const nextDeltaIndex = events.findIndex(
        ({ type }, index) =>
          index > firstDelta && type === "response.output_text.delta",
      );
      assert.ok(
        events
          .slice(firstDelta + 1, nextDeltaIndex)
          .some(({ type }) => type === "keepalive"),
      );
    } finally {
      controller.abort();
      nextDelta.resolve();
      tokenCounts.resolve();
    }
  });

  test("stops Responses heartbeats on a startup timeout", async () => {
    let cancelled = false;
    const model: vscode.LanguageModelChat = {
      ...createDelayedModel(),
      sendRequest: async (_messages, _options, token) => {
        token?.onCancellationRequested(() => {
          cancelled = true;
        });
        return new Promise(() => {});
      },
    };
    const response = await responsesRequest(model, undefined, 40);
    const events = parseResponsesEvents(await response.text());
    assert.strictEqual(response.status, 200);
    assert.ok(cancelled);
    assertResponseSequence(events, "response.failed");
    assert.strictEqual(events.at(-1)?.response.error.code, "request_timeout");
    assert.ok(events.some(({ type }) => type === "keepalive"));
  });

  test("cancels Responses startup when the streaming client disconnects", async () => {
    const cancellation = deferred();
    const controller = new AbortController();
    const model: vscode.LanguageModelChat = {
      ...createDelayedModel(),
      sendRequest: async (_messages, _options, token) => {
        token?.onCancellationRequested(cancellation.resolve);
        return new Promise(() => {});
      },
    };
    const response = await responsesRequest(model, controller.signal);
    const reader = response.body!.getReader();
    let body = "";
    const decoder = new TextDecoder();
    while (!body.includes('"sequence_number":2')) {
      const { done, value } = await reader.read();
      assert.ok(!done, "expected a heartbeat before stream closure");
      body += decoder.decode(value);
    }
    controller.abort();
    await cancellation.promise;
    assert.strictEqual((await reader.read()).done, true);
    reader.releaseLock();
    assert.ok(!body.includes("response.completed"));
  });

  test("waits for an in-flight heartbeat before finishing the operation", async () => {
    const heartbeatStarted = deferred();
    const heartbeatFinished = deferred();
    const operationFinished = deferred();
    let finished = false;
    let writes = 0;
    const running = withOpenAIResponsesHeartbeat(
      async () => {
        writes++;
        heartbeatStarted.resolve();
        await heartbeatFinished.promise;
      },
      { value: 0 },
      async () => operationFinished.promise,
      heartbeatIntervalMs,
    ).then(() => {
      finished = true;
    });
    await heartbeatStarted.promise;
    operationFinished.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(finished, false);
    heartbeatFinished.resolve();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.strictEqual(writes, 1);
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
