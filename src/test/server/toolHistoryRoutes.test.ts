import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { getRequestListener } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import { once } from "node:events";
import { createServer } from "node:http";
import OpenAI from "openai";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerGeminiRoutes } from "../../server/routes/geminiRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import {
  ThinkingPart,
  getThinkingRuntime,
} from "../../server/utils/languageModelThinking";

suite("Normalized history through official SDKs", () => {
  const modelMetadata = {
    id: "gpt-reasoning-test",
    name: "Test",
    family: "gpt",
    vendor: "copilot",
    version: "test",
    maxInputTokens: 200000,
    countTokens: async () => 1,
  };
  const responsesApp = (model: vscode.LanguageModelChat) => {
    const app = new OpenAPIHono();
    registerOpenaiResponsesRoutes(app, {
      requestTimeoutMs: 2000,
      resolveChatModelClient: async () => ({ client: model }),
    });
    return app;
  };
  const responsesClient = (app: OpenAPIHono) =>
    new OpenAI({
      apiKey: "test",
      baseURL: "http://localhost/v1",
      maxRetries: 0,
      fetch: async (input, init) => app.request(new Request(input, init)),
    });

  for (const stream of [false, true]) {
    test(`Responses classifies provider reasoning conflicts correctly (stream=${stream})`, async () => {
      const runtime = getThinkingRuntime()!;
      const model = {
        ...modelMetadata,
        sendRequest: async () => ({
          stream: (async function* () {
            for (const encrypted_content of [
              "first-private-state",
              "second-private-state",
            ]) {
              yield new runtime.Thinking("", "same-provider-id", {
                encrypted_content,
                vscode_thinking_origin_api: "responses",
              });
            }
          })(),
          text: (async function* () {})(),
        }),
      } as vscode.LanguageModelChat;
      const app = responsesApp(model);
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.id, input: "Check", stream }),
      });
      const body = await response.text();
      assert.ok(!body.includes("first-private-state"));
      assert.ok(!body.includes("second-private-state"));
      if (!stream) {
        assert.strictEqual(response.status, 502);
        const result = JSON.parse(body);
        assert.strictEqual(result.error.type, "upstream_error");
        assert.strictEqual(result.error.param, null);
        assert.strictEqual(result.error.code, "invalid_provider_reasoning");
      } else {
        assert.strictEqual(response.status, 200);
        const events = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)));
        assert.strictEqual(events.at(-1).type, "response.failed");
        assert.strictEqual(
          events.at(-1).response.error.code,
          "invalid_provider_reasoning",
        );
        assert.ok(!events.some((event) => event.type === "response.completed"));
        const reasoningDone = events.filter(
          (event) =>
            event.type === "response.output_item.done" &&
            event.item.type === "reasoning",
        );
        assert.strictEqual(reasoningDone.length, 1);
      }
    });
  }

  test("Responses still classifies conflicting input reasoning as a client error", async () => {
    let requests = 0;
    const model = {
      id: "gpt-input-conflict",
      sendRequest: async () => {
        requests++;
        throw new Error("Unexpected dispatch");
      },
    } as unknown as vscode.LanguageModelChat;
    const app = responsesApp(model);
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        input: [
          {
            type: "reasoning",
            id: "same-id",
            summary: [],
            encrypted_content: "first",
          },
          {
            type: "reasoning",
            id: "same-id",
            summary: [],
            encrypted_content: "second",
          },
        ],
      }),
    });
    assert.strictEqual(response.status, 400);
    const result = (await response.json()) as any;
    assert.strictEqual(result.error.code, "invalid_reasoning");
    assert.strictEqual(result.error.param, "input");
    assert.strictEqual(requests, 0);
  });
  test("Responses preserves text/tool ordering with or without reasoning in JSON and SSE", async () => {
    for (const stream of [false, true]) {
      for (const includeThinking of [false, true]) {
        const runtime = getThinkingRuntime()!;
        const thinking = new runtime.Thinking("", "rs_repeat", {
          encrypted_content: "state",
          vscode_thinking_origin_api: "responses",
        });
        const model = {
          ...modelMetadata,
          sendRequest: async () => ({
            stream: (async function* () {
              if (includeThinking) {
                yield thinking;
              }
              yield new vscode.LanguageModelTextPart("A");
              yield new vscode.LanguageModelToolCallPart("call", "lookup", {});
              if (includeThinking) {
                yield thinking;
              }
              yield new vscode.LanguageModelTextPart("B");
            })(),
            text: (async function* () {})(),
          }),
        } as vscode.LanguageModelChat;
        const app = responsesApp(model);
        const client = responsesClient(app);
        const response = await client.responses.create({
          model: model.id,
          input: "Read",
          stream,
        });
        let output: OpenAI.Responses.ResponseOutputItem[] = [];
        if ("output" in response) {
          output = response.output;
        } else {
          for await (const event of response) {
            if (event.type === "response.completed") {
              output = event.response.output;
            }
          }
        }
        assert.strictEqual(
          output.filter(({ type }) => type === "reasoning").length,
          includeThinking ? 1 : 0,
        );
        assert.deepStrictEqual(
          output
            .filter(({ type }) => type !== "reasoning")
            .map((item) =>
              item.type === "message"
                ? item.content
                    .map((part) =>
                      part.type === "output_text" ? part.text : "",
                    )
                    .join("")
                : item.type,
            ),
          ["A", "function_call", "B"],
        );
      }
    }
  });

  test("Responses rejects malformed encrypted reasoning before dispatch", async () => {
    let requests = 0;
    const model = {
      id: "gpt-invalid",
      sendRequest: async () => {
        requests++;
        throw new Error("unexpected");
      },
    } as unknown as vscode.LanguageModelChat;
    const app = responsesApp(model);
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.id,
        input: [
          { type: "reasoning", id: "rs", encrypted_content: 42, summary: [] },
        ],
      }),
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(
      ((await response.json()) as any).error.code,
      "invalid_reasoning",
    );
    assert.strictEqual(requests, 0);
  });
  test("Responses rejects metadata-discarding hosts before dispatch in JSON and SSE", async () => {
    const runtime = getThinkingRuntime()!;
    const originalThinking = runtime.Thinking;
    runtime.Thinking = class {
      readonly metadata = {};
      constructor(
        readonly value: string | string[],
        readonly id?: string,
      ) {}
    };
    let requests = 0;
    const model = {
      ...modelMetadata,
      sendRequest: async () => {
        requests++;
        throw new Error("Unexpected dispatch");
      },
    } as vscode.LanguageModelChat;
    const app = responsesApp(model);
    try {
      for (const stream of [false, true]) {
        for (const conflicting of [false, true]) {
          const response = await app.request("/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: model.id,
              stream,
              input: ["first", conflicting ? "second" : "first"].map(
                (encrypted_content) => ({
                  type: "reasoning",
                  id: "same-id",
                  summary: [],
                  encrypted_content,
                }),
              ),
            }),
          });
          assert.strictEqual(response.status, 400);
          const result = (await response.json()) as {
            error: { code: string; param: string };
          };
          assert.strictEqual(result.error.code, "reasoning_unavailable");
          assert.strictEqual(result.error.param, "input");
          assert.strictEqual(requests, 0);
        }
      }
    } finally {
      runtime.Thinking = originalThinking;
    }
  });
  for (const stream of [false, true] as const) {
    for (const custom of [false, true]) {
      test(`Responses reasoning survives SDK tool continuation (stream=${stream}, custom=${custom})`, async () => {
        let requestCount = 0;
        const model = {
          ...modelMetadata,
          sendRequest: async (messages, options) => {
            assert.strictEqual(
              (options as { includeEncryptedThinking?: boolean })
                ?.includeEncryptedThinking,
              true,
            );
            requestCount++;
            if (requestCount === 2) {
              const parts = messages.flatMap(({ content }) => content);
              const thinking = parts.find(
                (part) => part instanceof getThinkingRuntime()!.Thinking,
              ) as unknown as ThinkingPart;
              assert.strictEqual(thinking.id, "rs_tool");
              assert.deepStrictEqual(thinking.metadata, {
                encrypted_content: "opaque-tool-state",
                vscode_thinking_origin_api: "responses",
              });
              assert.strictEqual(thinking.value, "");
              assert.strictEqual(
                parts.filter(
                  (part) => part instanceof vscode.LanguageModelToolCallPart,
                ).length,
                1,
              );
              assert.strictEqual(
                parts.filter(
                  (part) => part instanceof vscode.LanguageModelToolResultPart,
                ).length,
                1,
              );
            }
            return {
              stream: (async function* () {
                yield new (getThinkingRuntime()!.Thinking)(
                  "private-text",
                  undefined,
                );
                yield new (getThinkingRuntime()!.Thinking)(
                  "",
                  requestCount === 1 ? "rs_tool" : "rs_final",
                  {
                    encrypted_content:
                      requestCount === 1
                        ? "opaque-tool-state"
                        : "opaque-final-state",
                    vscode_thinking_origin_api: "responses",
                  },
                );
                if (requestCount === 1) {
                  yield new vscode.LanguageModelTextPart("Before lookup");
                  yield new vscode.LanguageModelToolCallPart(
                    "lookup-call",
                    "lookup",
                    custom ? { input: "lookup()" } : {},
                  );
                  yield new vscode.LanguageModelTextPart("After lookup");
                } else {
                  yield new vscode.LanguageModelTextPart("ready");
                }
              })(),
              text: (async function* () {})(),
            };
          },
        } as vscode.LanguageModelChat;
        const app = responsesApp(model);
        const client = responsesClient(app);
        const tools: OpenAI.Responses.Tool[] = custom
          ? [{ type: "custom", name: "lookup", format: { type: "text" } }]
          : [
              {
                type: "function",
                name: "lookup",
                strict: false,
                parameters: { type: "object", properties: {} },
              },
            ];
        const history: OpenAI.Responses.ResponseInput = [
          { role: "user", content: "Read status" },
        ];
        const collect = async () => {
          const response = await client.responses.create({
            model: model.id,
            stream,
            tools,
            input: history,
          });
          if ("output" in response) {
            return response.output;
          }
          const done: OpenAI.Responses.ResponseOutputItem[] = [];
          let terminal: OpenAI.Responses.ResponseOutputItem[] = [];
          const sequence: number[] = [];
          for await (const event of response) {
            if (event.type === "response.output_item.done") {
              done.push(event.item);
            }
            if (event.type === "response.completed") {
              terminal = event.response.output;
            }
            sequence.push(event.sequence_number);
          }
          assert.deepStrictEqual(done, terminal);
          assert.deepStrictEqual(
            sequence,
            sequence.map((_, index) => index),
          );
          return terminal;
        };
        const output = await collect();
        assert.deepStrictEqual(
          output.map(({ type }) => type),
          [
            "reasoning",
            "message",
            custom ? "custom_tool_call" : "function_call",
            "message",
          ],
        );
        assert.ok(!JSON.stringify(output).includes("private-text"));
        history.push(
          ...(output.map((item) => {
            if (item.type !== "reasoning") {
              return item;
            }
            const { id: _id, ...replay } = item;
            return replay;
          }) as OpenAI.Responses.ResponseInput),
          custom
            ? {
                type: "custom_tool_call_output",
                call_id: "lookup-call",
                output: "ready",
              }
            : {
                type: "function_call_output",
                call_id: "lookup-call",
                output: "ready",
              },
        );
        const final = await collect();
        assert.deepStrictEqual(
          final.map(({ type }) => type),
          ["reasoning", "message"],
        );
        assert.strictEqual(requestCount, 2);
      });
    }
    test(`Responses custom tools retain their input contract (stream=${stream})`, async () => {
      const source = 'const message = "quoted";\ntext(message);';
      let requestCount = 0;
      const model = {
        id: "gpt-test",
        name: "Test",
        family: "gpt",
        vendor: "copilot",
        version: "test",
        maxInputTokens: 200000,
        capabilities: { supportsToolCalling: true, supportsImageToText: false },
        countTokens: async () => 1,
        sendRequest: async (messages, options) => {
          requestCount++;
          const tool = options?.tools?.[0];
          assert.strictEqual(tool?.name, "functions__exec");
          assert.strictEqual(
            tool.description,
            "Discover tools through ALL_TOOLS.\n\nRun JavaScript",
          );
          const schema = tool.inputSchema as {
            required: string[];
            properties: { input: { type: string } };
          };
          assert.deepStrictEqual(schema.required, ["input"]);
          assert.strictEqual(schema.properties.input.type, "string");
          const replay = messages
            .flatMap((message) => message.content)
            .find((part) => part instanceof vscode.LanguageModelToolCallPart);
          assert.ok(replay instanceof vscode.LanguageModelToolCallPart);
          assert.strictEqual(replay.name, tool.name);
          assert.deepStrictEqual(replay.input, { input: "text(ALL_TOOLS);" });
          return {
            stream: (async function* () {
              yield new vscode.LanguageModelToolCallPart(
                "new-exec-call",
                tool.name,
                { input: source },
              );
            })(),
            text: (async function* () {})(),
          };
        },
      } as vscode.LanguageModelChat;
      const app = new OpenAPIHono();
      registerOpenaiResponsesRoutes(app, {
        requestTimeoutMs: 2000,
        resolveChatModelClient: async () => ({ client: model }),
      });
      const client = new OpenAI({
        apiKey: "test",
        baseURL: "http://localhost/v1",
        maxRetries: 0,
        fetch: async (input, init) => app.request(new Request(input, init)),
      });
      const response = await client.responses.create({
        model: model.id,
        stream,
        tools: [
          {
            type: "namespace",
            name: "functions",
            description: "Discover tools through ALL_TOOLS.",
            tools: [
              {
                type: "custom",
                name: "exec",
                description: "Run JavaScript",
                format: { type: "text" },
              },
            ],
          },
        ],
        input: [
          { role: "user", content: "Inspect available tools." },
          {
            type: "custom_tool_call",
            call_id: "previous-exec-call",
            name: "exec",
            namespace: "functions",
            input: "text(ALL_TOOLS);",
          },
          {
            type: "custom_tool_call_output",
            call_id: "previous-exec-call",
            output: "[]",
          },
        ],
      });
      let output: OpenAI.Responses.ResponseOutputItem[] = [];
      if ("output" in response) {
        output = response.output;
      } else {
        const deltas: string[] = [];
        for await (const event of response) {
          if (event.type === "response.custom_tool_call_input.delta") {
            deltas.push(event.delta);
          }
          if (event.type === "response.completed") {
            output = event.response.output;
          }
        }
        assert.strictEqual(deltas.join(""), source);
      }
      assert.strictEqual(requestCount, 1);
      assert.strictEqual(output.length, 1);
      const call = output[0];
      if (call.type !== "custom_tool_call") {
        assert.fail("Expected a custom tool call");
      }
      assert.strictEqual(call.name, "exec");
      assert.strictEqual(call.namespace, "functions");
      assert.strictEqual(call.call_id, "new-exec-call");
      assert.strictEqual(call.input, source);
    });
  }

  test("all four routes preserve newly generated IDs while normalizing input", async () => {
    const captured: vscode.LanguageModelChatMessage[][] = [];
    const model = {
      id: "claude-test",
      name: "Test",
      family: "claude",
      vendor: "copilot",
      version: "test",
      maxInputTokens: 200000,
      capabilities: { supportsToolCalling: true, supportsImageToText: false },
      countTokens: async () => 1,
      sendRequest: async (messages: vscode.LanguageModelChatMessage[]) => {
        captured.push(messages);
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelToolCallPart(
              "new-client-call",
              "lookup",
              { key: "new" },
            );
          })(),
          text: (async function* () {})(),
        };
      },
    } as unknown as vscode.LanguageModelChat;
    const app = new OpenAPIHono();
    const options = {
      requestTimeoutMs: 2000,
      resolveChatModelClient: async () => ({ client: model }),
    };
    const anthropicRoutes = new OpenAPIHono();
    registerAnthropicRoutes(anthropicRoutes, options);
    app.route("/anthropic", anthropicRoutes);
    const chatRoutes = new OpenAPIHono();
    registerOpenaiChatRoutes(chatRoutes, options);
    app.route("/openai", chatRoutes);
    const responsesRoutes = new OpenAPIHono();
    registerOpenaiResponsesRoutes(responsesRoutes, options);
    app.route("/openai", responsesRoutes);
    const geminiRoutes = new OpenAPIHono();
    registerGeminiRoutes(geminiRoutes, options);
    app.route("/gemini", geminiRoutes);
    const server = createServer(getRequestListener(app.fetch));
    server.listen(0, "127.0.0.1");
    try {
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = "http://127.0.0.1:" + address.port;
      const anthropic = new Anthropic({
        apiKey: "test",
        baseURL: base + "/anthropic",
        maxRetries: 0,
      });
      const aStream = await anthropic.messages.create({
        model: model.id,
        max_tokens: 100,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "orphan",
                content: "saved context",
              },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "x", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
          },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "x", name: "lookup", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
          },
        ],
      });
      const aIds: string[] = [];
      for await (const event of aStream) {
        if (
          event.type === "content_block_start" &&
          event.content_block.type === "tool_use"
        ) {
          aIds.push(event.content_block.id);
        }
      }
      assert.deepStrictEqual(aIds, ["new-client-call"]);

      const openai = new OpenAI({
        apiKey: "test",
        baseURL: base + "/openai/v1",
        maxRetries: 0,
      });
      const cStream = await openai.chat.completions.create({
        model: model.id,
        stream: true,
        messages: [
          { role: "tool", tool_call_id: "orphan", content: "saved context" },
          {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                id: "x",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "x", content: "ok" },
          {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                id: "x",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "x", content: "ok" },
        ],
      });
      const cIds: string[] = [];
      for await (const chunk of cStream) {
        for (const choice of chunk.choices) {
          for (const call of choice.delta.tool_calls ?? []) {
            if (call.id) {
              cIds.push(call.id);
            }
          }
        }
      }
      assert.deepStrictEqual(cIds, ["new-client-call"]);
      const rStream = openai.responses.stream({
        model: model.id,
        input: [
          {
            type: "function_call_output",
            call_id: "orphan",
            output: "saved context",
          },
          {
            type: "function_call",
            call_id: "x",
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "x", output: "ok" },
          {
            type: "function_call",
            call_id: "x",
            name: "lookup",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "x", output: "ok" },
        ],
      });
      const response = await rStream.finalResponse();
      assert.deepStrictEqual(
        response.output
          .filter((o) => o.type === "function_call")
          .map((o) => o.call_id),
        ["new-client-call"],
      );

      const gemini = new GoogleGenAI({
        apiKey: "test",
        vertexai: false,
        httpOptions: { baseUrl: base + "/gemini", apiVersion: "v1beta" },
      });
      const gStream = await gemini.models.generateContentStream({
        model: model.id,
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "orphan",
                  name: "lookup",
                  response: { output: "saved context" },
                },
              },
            ],
          },
          {
            role: "model",
            parts: [{ functionCall: { id: "x", name: "lookup", args: {} } }],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "x",
                  name: "lookup",
                  response: { output: "ok" },
                },
              },
            ],
          },
          {
            role: "model",
            parts: [{ functionCall: { id: "x", name: "lookup", args: {} } }],
          },
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "x",
                  name: "lookup",
                  response: { output: "ok" },
                },
              },
            ],
          },
        ],
      });
      const gIds: Array<string | undefined> = [];
      for await (const chunk of gStream) {
        for (const call of chunk.functionCalls ?? []) {
          gIds.push(call.id);
        }
      }
      assert.deepStrictEqual(gIds, ["new-client-call"]);
      assert.strictEqual(captured.length, 4);
      for (const messages of captured) {
        const parts = messages.flatMap((m) => m.content);
        const calls = parts.filter(
          (p): p is vscode.LanguageModelToolCallPart =>
            p instanceof vscode.LanguageModelToolCallPart,
        );
        const results = parts.filter(
          (p): p is vscode.LanguageModelToolResultPart =>
            p instanceof vscode.LanguageModelToolResultPart,
        );
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(results.length, 2);
        assert.strictEqual(new Set(calls.map((c) => c.callId)).size, 2);
        assert.deepStrictEqual(
          results.map((r) => r.callId),
          calls.map((c) => c.callId),
        );
        assert.ok(
          parts.some(
            (p) =>
              p instanceof vscode.LanguageModelTextPart &&
              p.value.includes("saved context"),
          ),
        );
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
