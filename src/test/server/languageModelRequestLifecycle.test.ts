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

  const createSuccessfulModel = (
    onRequest: (messages: readonly vscode.LanguageModelChatMessage[]) => void,
  ): vscode.LanguageModelChat =>
    ({
      id: "test-model",
      name: "Test Model",
      family: "test",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: {
        supportsImageToText: true,
        supportsToolCalling: true,
      },
      sendRequest: async (messages) => {
        onRequest(messages);
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart("ok");
          })(),
          text: (async function* () {
            yield "ok";
          })(),
        };
      },
      countTokens: async () => 1,
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
    const responseBody = (await response.json()) as {
      error: { code: string; param: string | null };
    };
    assert.strictEqual(responseBody.error.code, "request_timeout");
    assert.strictEqual(responseBody.error.param, null);
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

  test("retries Responses once with tool history downgraded after a downstream pairing error", async () => {
    const capturedRequests: Array<readonly vscode.LanguageModelChatMessage[]> =
      [];
    const model = {
      id: "gpt-5.6-test",
      name: "GPT 5.6 Test",
      family: "gpt-5.6",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: true, supportsToolCalling: true },
      sendRequest: async (
        messages: readonly vscode.LanguageModelChatMessage[],
      ) => {
        capturedRequests.push(messages);
        if (capturedRequests.length === 1) {
          throw new Error(
            "Request Failed: 400 No tool call found for function call output with call_id call_exec_1.",
          );
        }
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart("recovered");
          })(),
          text: (async function* () {
            yield "recovered";
          })(),
        };
      },
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-test",
        input: [
          {
            type: "custom_tool_call",
            id: "ctc_exec_1",
            call_id: "call_exec_1",
            name: "exec",
            input: "git status",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_exec_1",
            output: "working tree clean",
          },
        ],
      }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(capturedRequests.length, 2);
    assert.ok(
      capturedRequests[0]
        .flatMap((message) => message.content)
        .some((part) => part instanceof vscode.LanguageModelToolCallPart),
    );
    const recoveredParts = capturedRequests[1].flatMap(
      (message) => message.content,
    );
    assert.ok(
      recoveredParts.every(
        (part) =>
          !(part instanceof vscode.LanguageModelToolCallPart) &&
          !(part instanceof vscode.LanguageModelToolResultPart),
      ),
    );
    assert.match(
      recoveredParts
        .filter((part) => part instanceof vscode.LanguageModelTextPart)
        .map((part) => part.value)
        .join("\n"),
      /git status[\s\S]*working tree clean/,
    );
  });

  test("retries Responses when downstream pairing fails before the first stream chunk", async () => {
    const capturedRequests: Array<readonly vscode.LanguageModelChatMessage[]> =
      [];
    const model = {
      id: "gpt-5.6-test",
      name: "GPT 5.6 Test",
      family: "gpt-5.6",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: true, supportsToolCalling: true },
      sendRequest: async (
        messages: readonly vscode.LanguageModelChatMessage[],
      ) => {
        capturedRequests.push(messages);
        const requestNumber = capturedRequests.length;
        return {
          stream: (async function* () {
            if (requestNumber === 1) {
              throw new Error(
                "No tool call found for function call output with call_id call_exec_1.",
              );
            }
            yield new vscode.LanguageModelTextPart("recovered");
          })(),
          text: (async function* () {})(),
        };
      },
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-test",
        stream: true,
        input: [
          {
            type: "custom_tool_call",
            id: "ctc_exec_1",
            call_id: "call_exec_1",
            name: "exec",
            input: "git status",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_exec_1",
            output: "working tree clean",
          },
        ],
      }),
    });
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(capturedRequests.length, 2);
    assert.ok(body.includes("recovered"));
    assert.ok(body.includes("response.completed"));
    assert.ok(!body.includes("response.failed"));
  });

  test("does not retry a downstream pairing error after model output starts", async () => {
    let requestCount = 0;
    const model = {
      id: "gpt-5.6-test",
      name: "GPT 5.6 Test",
      family: "gpt-5.6",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: true, supportsToolCalling: true },
      sendRequest: async () => {
        requestCount++;
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart("partial");
            throw new Error(
              "No tool call found for function call output with call_id call_exec_1.",
            );
          })(),
          text: (async function* () {})(),
        };
      },
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-test",
        stream: true,
        input: [
          {
            type: "custom_tool_call",
            id: "ctc_exec_1",
            call_id: "call_exec_1",
            name: "exec",
            input: "git status",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_exec_1",
            output: "working tree clean",
          },
        ],
      }),
    });
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(requestCount, 1);
    assert.ok(body.includes("partial"));
    assert.ok(body.includes("response.failed"));
    assert.ok(!body.includes("response.completed"));
  });

  test("attempts downstream tool-history recovery only once", async () => {
    let requestCount = 0;
    const model = {
      ...createSuccessfulModel(() => {}),
      sendRequest: async () => {
        requestCount++;
        throw new Error(
          "No tool call found for function call output with call_id call_exec_1.",
        );
      },
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        input: [
          {
            type: "function_call",
            id: "fc_exec_1",
            call_id: "call_exec_1",
            name: "exec",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_exec_1",
            output: "done",
          },
        ],
      }),
    });

    assert.strictEqual(response.status, 500);
    assert.strictEqual(requestCount, 2);
  });

  test("passes tool-output images to Responses models as DataPart", async () => {
    let capturedMessages: readonly vscode.LanguageModelChatMessage[] = [];
    const model = {
      id: "gpt-5.6-test",
      name: "GPT 5.6 Test",
      family: "gpt-5.6",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: true, supportsToolCalling: true },
      sendRequest: async (
        messages: readonly vscode.LanguageModelChatMessage[],
      ) => {
        capturedMessages = messages;
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart("ok");
          })(),
          text: (async function* () {
            yield "ok";
          })(),
        };
      },
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-test",
        input: [
          {
            type: "custom_tool_call",
            id: "ctc_view_image_1",
            call_id: "call_view_image_1",
            name: "exec",
            input: "view_image screenshot.png",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_view_image_1",
            output: [
              { type: "input_text", text: "Viewed an image" },
              {
                type: "input_image",
                image_url:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                detail: "high",
              },
            ],
          },
        ],
      }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(capturedMessages.length, 2);
    const toolResult = capturedMessages[1].content[0] as any;
    assert.ok(toolResult.content[0] instanceof vscode.LanguageModelTextPart);
    assert.ok(toolResult.content[1] instanceof vscode.LanguageModelDataPart);
  });

  test("recovers invalid tool IDs before both routes call the model", async () => {
    const capturedRequests: Array<readonly vscode.LanguageModelChatMessage[]> =
      [];
    const model = createSuccessfulModel((messages) => {
      capturedRequests.push(messages);
    });
    const anthropicApp = createAnthropicTestApp(model);
    const responsesApp = createOpenaiResponsesTestApp(model);

    const anthropicResponse = await anthropicApp.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 16,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", name: "missing", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: null,
                content: "invalid output",
              },
            ],
          },
        ],
      }),
    });
    const responsesResponse = await responsesApp.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        input: [
          {
            type: "function_call",
            id: "fc_missing",
            name: "missing",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: null,
            output: "invalid output",
          },
        ],
      }),
    });

    assert.strictEqual(anthropicResponse.status, 200);
    assert.strictEqual(responsesResponse.status, 200);
    assert.strictEqual(capturedRequests.length, 2);
    for (const request of capturedRequests) {
      const parts = request.flatMap((message) => message.content);
      assert.ok(
        parts.every(
          (part) =>
            !(part instanceof vscode.LanguageModelToolCallPart) &&
            !(part instanceof vscode.LanguageModelToolResultPart),
        ),
      );
    }
  });

  test("uses plaintext Codex collaboration arguments in Responses", async () => {
    let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
    const model = {
      id: "gpt-5.6-test",
      name: "GPT 5.6 Test",
      family: "gpt-5.6",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: false, supportsToolCalling: true },
      sendRequest: async (
        _messages: readonly vscode.LanguageModelChatMessage[],
        options?: vscode.LanguageModelChatRequestOptions,
      ) => {
        capturedOptions = options;
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelToolCallPart(
              "call_spawn_1",
              "collaboration__spawn_agent",
              {
                task_name: "reviewer",
                fork_turns: "none",
                message: "Review the current diff",
              },
            );
          })(),
          text: (async function* () {})(),
        };
      },
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);
    const request = {
      model: "gpt-5.6-test",
      input: "Delegate this review",
      tools: [
        {
          type: "namespace",
          name: "collaboration",
          description: "Sub-agent tools",
          tools: [
            {
              type: "function",
              name: "spawn_agent",
              description: "Spawn a reviewer",
              parameters: {
                type: "object",
                properties: {
                  task_name: { type: "string" },
                  message: { type: "string", encrypted: true },
                },
                required: ["task_name", "message"],
              },
            },
          ],
        },
      ],
    };

    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = (await response.json()) as any;
    const inputSchema = capturedOptions?.tools?.[0].inputSchema as any;

    assert.strictEqual(response.status, 200);
    assert.strictEqual(inputSchema.properties.message.encrypted, undefined);
    assert.deepStrictEqual(body.output[0].encrypted_function_args, []);

    const streamingResponse = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream: true }),
    });
    const streamingBody = await streamingResponse.text();

    assert.strictEqual(streamingResponse.status, 200);
    assert.strictEqual(
      (streamingBody.match(/"encrypted_function_args":\[\]/g) ?? []).length,
      3,
    );
  });

  test("handles an unavailable Responses web search provider", async () => {
    let capturedOptions: vscode.LanguageModelChatRequestOptions | undefined;
    const model = {
      id: "gpt-5.6-test",
      name: "GPT 5.6 Test",
      family: "gpt-5.6",
      version: "test",
      vendor: "copilot",
      maxInputTokens: 200000,
      capabilities: { supportsImageToText: false, supportsToolCalling: true },
      sendRequest: async (
        _messages: readonly vscode.LanguageModelChatMessage[],
        options?: vscode.LanguageModelChatRequestOptions,
      ) => {
        capturedOptions = options;
        return {
          stream: (async function* () {
            yield new vscode.LanguageModelTextPart("ok");
          })(),
          text: (async function* () {
            yield "ok";
          })(),
        };
      },
      countTokens: async () => 1,
    } as unknown as vscode.LanguageModelChat;
    const app = createOpenaiResponsesTestApp(model);
    const request = {
      model: "gpt-5.6-test",
      input: "Search the web",
      tools: [{ type: "web_search" }],
    };

    const autoResponse = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, tool_choice: "auto" }),
    });

    assert.strictEqual(autoResponse.status, 200);
    assert.strictEqual(capturedOptions?.tools, undefined);
    assert.strictEqual(capturedOptions?.toolMode, undefined);

    const requiredResponse = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, tool_choice: "required" }),
    });
    const requiredBody = (await requiredResponse.json()) as any;

    assert.strictEqual(requiredResponse.status, 400);
    assert.strictEqual(requiredBody.error.code, "tool_unavailable");
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
