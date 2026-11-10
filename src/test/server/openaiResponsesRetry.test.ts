import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import OpenAI from "openai";
import * as vscode from "vscode";

import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import { getThinkingRuntime } from "../../server/utils/languageModelThinking";
import { logger } from "../../utils/logger";

interface Round {
  parts?: unknown[];
  error?: Error;
  startupError?: Error;
}

interface ResponseEvent {
  type: string;
  sequence_number: number;
  delta?: string;
  item?: { type: string; id: string };
  response?: {
    id: string;
    status: string;
    error?: { code: string; message: string } | null;
  };
}

const noChoices = () => new Error("Response contained no choices.");

const createModel = (rounds: Round[], vendor = "copilot") => {
  const requests: Array<{
    messages: vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions | undefined;
    token: vscode.CancellationToken | undefined;
  }> = [];
  const model: vscode.LanguageModelChat = {
    id: "gpt-retry-test",
    name: "Retry Test",
    family: "gpt",
    version: "test",
    vendor,
    maxInputTokens: 200_000,
    sendRequest: async (messages, options, token) => {
      const round = rounds[requests.length];
      requests.push({ messages, options, token });
      assert.ok(round, "Unexpected extra model request");
      if (round.startupError) {
        throw round.startupError;
      }
      return {
        stream: (async function* () {
          yield* round.parts ?? [];
          if (round.error) {
            throw round.error;
          }
        })(),
        text: (async function* () {})(),
      };
    },
    countTokens: async () => 1,
  };
  return { model, requests };
};

const request = (
  model: vscode.LanguageModelChat,
  {
    stream = true,
    signal,
    timeoutMs = 2_000,
  }: { stream?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
) => {
  const app = new OpenAPIHono();
  registerOpenaiResponsesRoutes(app, {
    heartbeatIntervalMs: 5,
    requestTimeoutMs: timeoutMs,
    resolveChatModelClient: async () => ({ client: model }),
  });
  return app.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      instructions: "Synthetic retry check.",
      input: "Hello",
      reasoning: { effort: "max" },
      stream,
    }),
    signal,
  });
};

const parseEvents = (body: string): ResponseEvent[] =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));

suite("OpenAI Responses Empty Response Retry Test Suite", () => {
  let originalWarn: typeof logger.warn;
  let warnings: string[];

  setup(() => {
    originalWarn = logger.warn;
    warnings = [];
    logger.warn = (message) => warnings.push(message);
  });

  teardown(() => {
    logger.warn = originalWarn;
  });

  for (const phase of ["startup", "stream"] as const) {
    test(`retries a Copilot no-choices ${phase} error before any model output`, async () => {
      const failure =
        phase === "startup"
          ? { startupError: noChoices() }
          : { error: noChoices() };
      const { model, requests } = createModel([
        failure,
        { parts: [new vscode.LanguageModelTextPart("recovered")] },
      ]);
      const response = await request(model);
      const events = parseEvents(await response.text());

      assert.strictEqual(events.at(-1)?.type, "response.completed");
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /no choices/i);
      assert.deepStrictEqual(requests[0], requests[1]);
      assert.deepStrictEqual(
        events
          .filter(({ type }) => type === "response.output_text.delta")
          .map(({ delta }) => delta),
        ["recovered"],
      );
      assert.strictEqual(
        events.filter(({ type }) => type === "response.created").length,
        1,
      );
      assert.ok(events.some(({ type }) => type === "keepalive"));
      assert.ok(!events.some(({ type }) => type === "response.failed"));
      assert.deepStrictEqual(
        events.map(({ sequence_number }) => sequence_number),
        events.map((_, index) => index),
      );
      assert.ok(
        events
          .filter(({ response }) => response)
          .every(({ response }) => response?.id === events[0].response?.id),
      );
    });
  }

  test("also recovers non-streaming Responses requests", async () => {
    const { model, requests } = createModel([
      { error: noChoices() },
      { parts: [new vscode.LanguageModelTextPart("recovered")] },
    ]);
    const response = await request(model, { stream: false });
    const body = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body.status, "completed");
    assert.strictEqual(body.output[0].content[0].text, "recovered");
    assert.strictEqual(requests.length, 2);
  });

  test("keeps the output-limit default failure private outside hosted search", async () => {
    const { model, requests } = createModel([
      {
        parts: [
          new (getThinkingRuntime()!.Thinking)("", "rs_unhandled", {
            encrypted_content: "unhandled-state",
            vscode_thinking_origin_api: "responses",
          }),
        ],
        error: new Error("Response too long for the configured limit"),
      },
    ]);
    const response = await request(model);
    const events = parseEvents(await response.text());

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(events.at(-1)?.type, "response.failed");
    assert.ok(!events.some(({ item }) => item?.type === "reasoning"));
    assert.strictEqual(warnings.length, 0);
  });

  test("surfaces the error after one unsuccessful retry", async () => {
    const { model, requests } = createModel([
      { error: noChoices() },
      { error: noChoices() },
    ]);
    const response = await request(model);
    const events = parseEvents(await response.text());

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(events.at(-1)?.type, "response.failed");
    assert.strictEqual(
      events.at(-1)?.response?.error?.message,
      noChoices().message,
    );
    assert.strictEqual(
      events.filter(({ type }) => type === "response.failed").length,
      1,
    );
    assert.ok(!events.some(({ type }) => type === "response.completed"));
  });

  test("recovers reasoning-only failures without exposing failed encrypted state", async () => {
    const runtime = getThinkingRuntime()!;
    const thinking = (id: string) =>
      new runtime.Thinking("", id, {
        encrypted_content: `opaque-${id}`,
        vscode_thinking_origin_api: "responses",
      });
    for (const stream of [false, true]) {
      const { model, requests } = createModel([
        {
          parts: [thinking("failed-first"), thinking("failed-second")],
          error: noChoices(),
        },
        {
          parts: [
            thinking("successful"),
            new vscode.LanguageModelTextPart("recovered"),
          ],
        },
      ]);
      const response = await request(model, { stream });
      const body = await response.text();

      assert.strictEqual(response.status, 200);
      assert.strictEqual(requests.length, 2);
      assert.ok(!body.includes("failed-first"));
      assert.ok(!body.includes("failed-second"));
      assert.ok(body.includes("opaque-successful"));
      if (stream) {
        const events = parseEvents(body);
        assert.strictEqual(events.at(-1)?.type, "response.completed");
        assert.deepStrictEqual(
          events
            .filter(({ type }) => type === "response.output_item.done")
            .map(({ item }) => item?.type),
          ["reasoning", "message"],
        );
        assert.deepStrictEqual(
          events.map(({ sequence_number }) => sequence_number),
          events.map((_, index) => index),
        );
      } else {
        assert.strictEqual(JSON.parse(body).status, "completed");
      }
    }
  });

  test("preserves successful reasoning-only responses", async () => {
    const runtime = getThinkingRuntime()!;
    const { model, requests } = createModel([
      {
        parts: [
          new runtime.Thinking("", "successful", {
            encrypted_content: "opaque-successful",
            vscode_thinking_origin_api: "responses",
          }),
        ],
      },
    ]);
    const response = await request(model);
    const events = parseEvents(await response.text());

    assert.strictEqual(events.at(-1)?.type, "response.completed");
    assert.ok(events.some(({ item }) => item?.type === "reasoning"));
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(warnings.length, 0);
  });

  test("the OpenAI SDK receives one successful stream without a client retry", async () => {
    const runtime = getThinkingRuntime()!;
    const { model, requests } = createModel([
      {
        parts: [
          new runtime.Thinking("", "failed-state", {
            encrypted_content: "discarded-state",
            vscode_thinking_origin_api: "responses",
          }),
        ],
        error: noChoices(),
      },
      { parts: [new vscode.LanguageModelTextPart("recovered")] },
    ]);
    let clientRequests = 0;
    const client = new OpenAI({
      apiKey: "test",
      maxRetries: 0,
      fetch: async () => {
        clientRequests++;
        return request(model);
      },
    });
    const stream = client.responses.stream({
      model: model.id,
      input: "Synthetic retry check.",
    });
    const response = await stream.finalResponse();

    assert.strictEqual(response.status, "completed");
    assert.strictEqual(response.output_text, "recovered");
    assert.strictEqual(clientRequests, 1);
    assert.strictEqual(requests.length, 2);
    assert.ok(!JSON.stringify(response).includes("discarded-state"));
  });

  test("discards buffered reasoning when both attempts fail", async () => {
    const runtime = getThinkingRuntime()!;
    const { model, requests } = createModel(
      ["first", "second"].map((id) => ({
        parts: [
          new runtime.Thinking("", id, {
            encrypted_content: `opaque-${id}`,
            vscode_thinking_origin_api: "responses",
          }),
        ],
        error: noChoices(),
      })),
    );
    const response = await request(model);
    const body = await response.text();
    const events = parseEvents(body);

    assert.strictEqual(requests.length, 2);
    assert.strictEqual(events.at(-1)?.type, "response.failed");
    assert.ok(!body.includes("opaque-"));
    assert.ok(
      !events.some(({ type }) => type === "response.output_item.added"),
    );
  });

  test("does not replay reasoning followed by partial text", async () => {
    const runtime = getThinkingRuntime()!;
    const { model, requests } = createModel([
      {
        parts: [
          new runtime.Thinking("", "successful", {
            encrypted_content: "opaque-successful",
            vscode_thinking_origin_api: "responses",
          }),
          new vscode.LanguageModelTextPart("partial"),
        ],
        error: noChoices(),
      },
    ]);
    const response = await request(model);
    const events = parseEvents(await response.text());

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(events.at(-1)?.type, "response.failed");
    assert.deepStrictEqual(
      events
        .filter(({ type }) => type === "response.output_item.added")
        .map(({ item }) => item?.type),
      ["reasoning", "message"],
    );
    assert.strictEqual(warnings.length, 0);
  });

  test("never replays after text, tools, visible thinking, usage, or unknown parts", async () => {
    const runtime = getThinkingRuntime()!;
    const parts = [
      new vscode.LanguageModelTextPart("partial"),
      new vscode.LanguageModelTextPart(""),
      new vscode.LanguageModelToolCallPart("call-1", "lookup", {}),
      new runtime.Thinking("visible reasoning", "reasoning-1", {
        encrypted_content: "opaque-test-state",
        vscode_thinking_origin_api: "responses",
      }),
      new vscode.LanguageModelDataPart(new Uint8Array(), "usage"),
      { futurePart: true },
    ];
    for (const part of parts) {
      const { model, requests } = createModel([
        { parts: [part], error: noChoices() },
      ]);
      const response = await request(model);
      const events = parseEvents(await response.text());

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(events.at(-1)?.type, "response.failed");
      assert.strictEqual(warnings.length, 0);
    }
  });

  test("does not retry unrelated upstream errors or other vendors", async () => {
    for (const [vendor, error] of [
      ["copilot", new Error("Rate limit exceeded")],
      ["copilot", new Error("Response contained no choices. Extra detail")],
      ["another-provider", noChoices()],
    ] as const) {
      const { model, requests } = createModel([{ error }], vendor);
      const response = await request(model);
      const events = parseEvents(await response.text());

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(
        events.at(-1)?.response?.error?.message,
        error.message,
      );
      assert.strictEqual(warnings.length, 0);
    }
  });

  test("does not retry a successfully completed empty stream", async () => {
    const { model, requests } = createModel([{}]);
    const response = await request(model);
    const events = parseEvents(await response.text());

    assert.strictEqual(events.at(-1)?.type, "response.completed");
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(warnings.length, 0);
  });

  test("client cancellation prevents a scheduled retry", async () => {
    const controller = new AbortController();
    const { model, requests } = createModel([{ error: noChoices() }]);
    logger.warn = (message) => {
      warnings.push(message);
      controller.abort();
    };
    const response = await request(model, { signal: controller.signal });
    await response.text();

    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].token?.isCancellationRequested, true);
  });

  test("does not start a model request for an already disconnected client", async () => {
    const controller = new AbortController();
    controller.abort();
    const { model, requests } = createModel([]);
    const response = await request(model, {
      stream: false,
      signal: controller.signal,
    });

    assert.strictEqual(response.status, 499);
    assert.strictEqual(requests.length, 0);
    assert.strictEqual(warnings.length, 0);
  });

  test("retry backoff stays inside the original request timeout", async () => {
    const { model, requests } = createModel([{ error: noChoices() }]);
    const response = await request(model, { timeoutMs: 30 });
    const events = parseEvents(await response.text());

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(events.at(-1)?.response?.error?.code, "request_timeout");
    assert.strictEqual(requests[0].token?.isCancellationRequested, true);
  });

  test("a stalled retry is cancelled by the original deadline", async () => {
    const { model } = createModel([]);
    let attempts = 0;
    let cancelled = false;
    model.sendRequest = async (_messages, _options, token) => {
      attempts++;
      if (attempts === 1) {
        throw noChoices();
      }
      token?.onCancellationRequested(() => {
        cancelled = true;
      });
      return new Promise(() => {});
    };
    const response = await request(model, { timeoutMs: 500 });
    const events = parseEvents(await response.text());

    assert.strictEqual(attempts, 2);
    assert.strictEqual(cancelled, true);
    assert.strictEqual(events.at(-1)?.response?.error?.code, "request_timeout");
    assert.ok(events.some(({ type }) => type === "keepalive"));
  });
});
