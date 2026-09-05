import { FinishReason, GoogleGenAI } from "@google/genai";
import { getRequestListener } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import { once } from "node:events";
import { createServer } from "node:http";
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

  test("delivers blank-line Gemini heartbeats before the model responds", async () => {
    let releaseModel!: () => void;
    const modelReady = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const app = new OpenAPIHono();
    registerGeminiRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 1000,
      resolveChatModelClient: async () => ({
        client: {
          ...createDelayedModel(),
          sendRequest: async () => ({
            stream: (async function* () {
              await modelReady;
              yield new vscode.LanguageModelTextPart("Hello");
            })(),
            text: (async function* () {})(),
          }),
        },
      }),
    });
    const server = createServer(getRequestListener(app.fetch));
    server.listen(0, "127.0.0.1");

    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1beta/models/claude-opus-test:streamGenerateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          }),
          signal: AbortSignal.timeout(2000),
        },
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let body = "";
      for (let index = 0; index < 2; index++) {
        const heartbeat = await reader.read();
        assert.strictEqual(heartbeat.done, false);
        const text = decoder.decode(heartbeat.value);
        assert.match(text, /^\n+$/);
        body += text;
      }
      releaseModel();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        body += decoder.decode(chunk.value, { stream: true });
      }

      assert.strictEqual(response.status, 200);
      assert.ok(!body.includes(": keep-alive"));
      assert.ok(!body.includes("data: {}"));
      assert.ok(body.includes('"text":"Hello"'));
      assert.ok(body.includes('"finishReason":"STOP"'));
    } finally {
      releaseModel();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("Google Gen AI SDK ignores Gemini heartbeats and preserves text, tools, and usage", async () => {
    const app = new OpenAPIHono();
    const toolCall = new vscode.LanguageModelToolCallPart(
      "write-report",
      "write_file",
      { file_path: "tmp/report.md", content: '# 调研\n\n"quoted" text' },
    );
    const tokenInputs: unknown[] = [];
    registerGeminiRoutes(app, {
      heartbeatIntervalMs,
      requestTimeoutMs: 1000,
      resolveChatModelClient: async () => ({
        client: {
          ...createDelayedModel(),
          sendRequest: async () => ({
            stream: (async function* () {
              await new Promise((resolve) => setTimeout(resolve, 25));
              yield new vscode.LanguageModelTextPart("Hello");
              await new Promise((resolve) => setTimeout(resolve, 25));
              yield toolCall;
              await new Promise((resolve) => setTimeout(resolve, 25));
            })(),
            text: (async function* () {})(),
          }),
          countTokens: async (input) => {
            tokenInputs.push(input);
            return 1;
          },
        },
      }),
    });
    const server = createServer(getRequestListener(app.fetch));
    server.listen(0, "127.0.0.1");

    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const sdk = new GoogleGenAI({
        apiKey: "test-key",
        vertexai: false,
        httpOptions: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiVersion: "v1beta",
          timeout: 1000,
        },
      });
      const stream = await sdk.models.generateContentStream({
        model: "claude-opus-test",
        contents: "Hello",
      });
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      assert.strictEqual(
        chunks.length,
        3,
        "Heartbeats must not yield SDK responses",
      );
      assert.strictEqual(chunks[0].text, "Hello");
      assert.strictEqual(chunks[1].functionCalls?.length, 1);
      assert.strictEqual(
        chunks.map((chunk) => chunk.text ?? "").join(""),
        "Hello",
      );
      assert.deepStrictEqual(
        chunks.flatMap((chunk) => chunk.functionCalls ?? []),
        [{ id: toolCall.callId, name: toolCall.name, args: toolCall.input }],
      );
      const finalChunk = chunks.at(-1)!;
      assert.deepStrictEqual(finalChunk.candidates, [
        { finishReason: FinishReason.STOP, index: 0 },
      ]);
      assert.deepStrictEqual(finalChunk.usageMetadata, {
        cachedContentTokenCount: 0,
        candidatesTokenCount: 1,
        promptTokenCount: 1,
        thoughtsTokenCount: 0,
        totalTokenCount: 2,
      });
      assert.strictEqual(
        chunks.filter((chunk) => chunk.usageMetadata).length,
        1,
      );
      assert.strictEqual(tokenInputs.length, 2);
      assert.strictEqual(tokenInputs[1], `Hello${JSON.stringify(toolCall)}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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
