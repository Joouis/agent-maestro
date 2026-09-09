import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import { LanguageModelRequestLifecycle } from "../../server/utils/languageModelRequestLifecycle";
import { streamResponsesWithHistoryRecovery } from "../../server/utils/responsesHistoryRecovery";

const paired = () => [
  vscode.LanguageModelChatMessage.Assistant([
    new vscode.LanguageModelToolCallPart("call_example", "lookup", {
      key: "value",
    }),
  ]),
  vscode.LanguageModelChatMessage.User([
    new vscode.LanguageModelToolResultPart("call_example", [
      new vscode.LanguageModelTextPart("saved output"),
    ]),
  ]),
];
const mismatch = () =>
  new Error(
    "Request Failed: 400 No tool call found for function call output with call_id call_example.",
  );
const success = () => ({
  stream: (async function* () {
    yield new vscode.LanguageModelTextPart("ok");
  })(),
  text: (async function* () {})(),
});
const model = (
  sendRequest: vscode.LanguageModelChat["sendRequest"],
  vendor = "copilot",
) =>
  Object.freeze({
    id: "test",
    vendor,
    sendRequest,
    countTokens: async () => 1,
  }) as unknown as vscode.LanguageModelChat;
async function collect(stream: AsyncIterable<unknown>) {
  const parts: unknown[] = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

suite("Opt-in Responses history recovery", () => {
  test("hosted search bypasses recovery even when enabled", async () => {
    let count = 0;
    const app = new OpenAPIHono();
    const client = model(async () => {
      count++;
      throw mismatch();
    });
    registerOpenaiResponsesRoutes(app, {
      resolveChatModelClient: async () => ({ client }),
      isToolHistoryRecoveryEnabled: () => true,
      webSearchProvider: { search: async () => [] },
    });
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        stream: true,
        tools: [{ type: "web_search" }],
        input: [
          {
            type: "function_call",
            call_id: "call_example",
            name: "lookup",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_example",
            output: "saved",
          },
          { role: "user", content: "Search now" },
        ],
      }),
    });
    assert.ok((await response.text()).includes("No tool call found"));
    assert.strictEqual(count, 1);
  });
  let lifecycle: LanguageModelRequestLifecycle;
  setup(() => {
    lifecycle = new LanguageModelRequestLifecycle(
      new AbortController().signal,
      2000,
    );
  });
  teardown(() => {
    lifecycle.dispose();
  });
  const run = (
    client: vscode.LanguageModelChat,
    enabled = true,
    messages = paired(),
    options = {},
  ) =>
    collect(
      streamResponsesWithHistoryRecovery(
        client,
        messages,
        options,
        lifecycle,
        enabled,
      ),
    );

  test("disabled and non-Copilot modes never retry", async () => {
    for (const [enabled, vendor] of [
      [false, "copilot"],
      [true, "other"],
    ] as const) {
      let count = 0;
      const client = model(async () => {
        count++;
        throw mismatch();
      }, vendor);
      await assert.rejects(run(client, enabled));
      assert.strictEqual(count, 1);
    }
  });
  test("normal request identity, options and output remain unchanged", async () => {
    const messages = paired(),
      options = { tools: [{ name: "lookup", inputSchema: {} }] };
    const client = model(async (m, o) => {
      assert.strictEqual(m, messages);
      assert.strictEqual(o, options);
      return success();
    });
    assert.strictEqual((await run(client, true, messages, options)).length, 1);
  });
  test("direct rejection retries once preserving context and new tool calls", async () => {
    let count = 0;
    const messages = paired();
    const original = JSON.stringify(messages);
    const options = { tools: [{ name: "lookup", inputSchema: {} }] };
    const newCall = new vscode.LanguageModelToolCallPart(
      "new_call",
      "lookup",
      {},
    );
    const client = model(async (m, o) => {
      assert.strictEqual(o, options);
      if (++count === 1) {
        throw mismatch();
      }
      assert.ok(
        m
          .flatMap((x) => x.content)
          .every(
            (p) =>
              !(p instanceof vscode.LanguageModelToolCallPart) &&
              !(p instanceof vscode.LanguageModelToolResultPart),
          ),
      );
      assert.ok(JSON.stringify(m).includes("saved output"));
      assert.ok(JSON.stringify(m).includes("value"));
      return {
        stream: (async function* () {
          yield newCall;
        })(),
        text: (async function* () {})(),
      };
    });
    assert.deepStrictEqual(await run(client, true, messages, options), [
      newCall,
    ]);
    assert.strictEqual(count, 2);
    assert.strictEqual(JSON.stringify(messages), original);
  });
  test("pre-output stream rejection retries", async () => {
    let count = 0;
    const client = model(async () =>
      ++count === 1
        ? {
            stream: (async function* () {
              throw mismatch();
            })(),
            text: (async function* () {})(),
          }
        : success(),
    );
    assert.strictEqual((await run(client)).length, 1);
    assert.strictEqual(count, 2);
  });
  test("no retry after text, tool call, metadata, or unknown output", async () => {
    for (const part of [
      new vscode.LanguageModelTextPart("partial"),
      new vscode.LanguageModelToolCallPart("new", "lookup", {}),
      new vscode.LanguageModelDataPart(new Uint8Array([1]), "application/json"),
      {},
    ]) {
      let count = 0;
      const client = model(async () => {
        count++;
        return {
          stream: (async function* () {
            yield part;
            throw mismatch();
          })(),
          text: (async function* () {})(),
        };
      });
      await assert.rejects(run(client));
      assert.strictEqual(count, 1);
    }
  });
  test("failed recovery is not retried again", async () => {
    let count = 0;
    const client = model(async () => {
      count++;
      throw mismatch();
    });
    await assert.rejects(run(client));
    assert.strictEqual(count, 2);
  });
  test("unrelated errors or unknown call IDs do not retry", async () => {
    for (const error of [
      new Error("Unauthorized"),
      new Error(
        "No tool call found for function call output with call_id other.",
      ),
    ]) {
      let count = 0;
      const client = model(async () => {
        count++;
        throw error;
      });
      await assert.rejects(run(client));
      assert.strictEqual(count, 1);
    }
  });
  test("incomplete, reversed, duplicate and wrong-role pairs do not retry", async () => {
    const h = paired();
    for (const messages of [
      h.slice(0, 1),
      h.slice(1),
      [...h].reverse(),
      [...h, ...h],
      [{ ...h[0], role: vscode.LanguageModelChatMessageRole.User }, h[1]],
    ]) {
      let count = 0;
      const client = model(async () => {
        count++;
        throw mismatch();
      });
      await assert.rejects(run(client, true, messages));
      assert.strictEqual(count, 1);
    }
  });
  test("parallel calls, text and data survive recovery", async () => {
    const data = new vscode.LanguageModelDataPart(
      new Uint8Array([1, 2]),
      "image/png",
    );
    const messages = paired();
    messages[0].content.push(
      new vscode.LanguageModelToolCallPart("parallel", "lookup", {}),
    );
    messages[1].content.unshift(
      new vscode.LanguageModelTextPart("note"),
      new vscode.LanguageModelToolResultPart("parallel", [data]),
    );
    let count = 0;
    const client = model(async (m) => {
      if (++count === 1) {
        throw mismatch();
      }
      assert.ok(m[1].content.includes(data));
      assert.ok(JSON.stringify(m).includes("note"));
      return success();
    });
    await run(client, true, messages);
    assert.strictEqual(count, 2);
  });
  test("cancellation before or during rejection prevents retries", async () => {
    const controller = new AbortController();
    lifecycle.dispose();
    lifecycle = new LanguageModelRequestLifecycle(controller.signal, 2000);
    let count = 0;
    const client = model(async () => {
      count++;
      controller.abort();
      throw mismatch();
    });
    await assert.rejects(run(client));
    assert.strictEqual(count, 1);
    await assert.rejects(run(client));
    assert.strictEqual(count, 1);
  });
  test("recovery stream remains subject to original timeout", async () => {
    lifecycle.dispose();
    lifecycle = new LanguageModelRequestLifecycle(
      new AbortController().signal,
      30,
    );
    let count = 0;
    const client = model(async () => {
      if (++count === 1) {
        throw mismatch();
      }
      return {
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
            };
          },
        },
        text: (async function* () {})(),
      };
    });
    await assert.rejects(run(client), /timed out/);
    assert.strictEqual(count, 2);
  });

  for (const stream of [false, true]) {
    test("HTTP route opt-in and opt-out: stream=" + stream, async () => {
      let enabled = false,
        count = 0;
      const app = new OpenAPIHono();
      const client = model(async () => {
        if (++count % 2 === 1) {
          throw mismatch();
        }
        return success();
      });
      registerOpenaiResponsesRoutes(app, {
        resolveChatModelClient: async () => ({ client }),
        isToolHistoryRecoveryEnabled: () => enabled,
        heartbeatIntervalMs: 5,
      });
      const request = () =>
        app.request("/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "test",
            stream,
            input: [
              {
                type: "custom_tool_call",
                call_id: "call_example",
                name: "lookup",
                input: "saved input",
              },
              {
                type: "custom_tool_call_output",
                call_id: "call_example",
                output: "saved output",
              },
            ],
          }),
        });
      const off = await request();
      const offBody = await off.text();
      assert.ok(offBody.includes("No tool call found"));
      assert.strictEqual(count, 1);
      enabled = true;
      count = 0;
      const on = await request();
      const onBody = await on.text();
      assert.strictEqual(on.status, 200);
      assert.ok(onBody.includes("completed"));
      assert.ok(onBody.includes("ok"));
      assert.strictEqual(count, 2);
      enabled = false;
      count = 0;
      await (await request()).text();
      assert.strictEqual(count, 1);
    });
  }
});
