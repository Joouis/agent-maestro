import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerOpenaiRoutes } from "../../server/routes/openai/openaiRoutes";
import { chatModelsCache } from "../../utils/chatModels";

suite("General Copilot Grok Proxy Test Suite", () => {
  for (const protocol of ["chat", "responses", "anthropic"] as const) {
    for (const stream of [false, true]) {
      test(`${protocol} discovers Grok and replays client tools (stream=${stream})`, async () => {
        const original = chatModelsCache.getChatModels;
        let requests = 0;
        const model = {
          id: "grok-test",
          name: "Grok Test",
          family: "grok",
          vendor: "copilot",
          version: "test",
          maxInputTokens: 400000,
          countTokens: async () => 1,
          sendRequest: async (messages, options) => {
            requests++;
            assert.strictEqual(options?.tools?.[0].name, "echo_probe");
            if (requests === 2) {
              const parts = messages.flatMap((message) => message.content);
              const call = parts.find(
                (part) => part instanceof vscode.LanguageModelToolCallPart,
              );
              const result = parts.find(
                (part) => part instanceof vscode.LanguageModelToolResultPart,
              );
              assert.ok(call instanceof vscode.LanguageModelToolCallPart);
              assert.ok(result instanceof vscode.LanguageModelToolResultPart);
              assert.strictEqual(call.callId, result.callId);
              assert.deepStrictEqual(call.input, { text: "CONNECTED" });
              assert.ok(
                result.content.some(
                  (part) =>
                    part instanceof vscode.LanguageModelTextPart &&
                    part.value === "CONNECTED",
                ),
              );
            }
            const first = requests === 1;
            return {
              stream: (async function* () {
                yield first
                  ? new vscode.LanguageModelToolCallPart(
                      "probe-call",
                      "echo_probe",
                      { text: "CONNECTED" },
                    )
                  : new vscode.LanguageModelTextPart("CONNECTED");
              })(),
              text: (async function* () {})(),
            };
          },
        } as vscode.LanguageModelChat;
        try {
          chatModelsCache.getChatModels = async () => [model];
          const app = new OpenAPIHono();
          const openai = new OpenAPIHono();
          registerOpenaiRoutes(openai);
          app.route("/api/openai", openai);
          const anthropic = new OpenAPIHono();
          registerAnthropicRoutes(anthropic);
          app.route("/api/anthropic", anthropic);
          const listPath =
            protocol === "anthropic"
              ? "/api/anthropic/v1/models"
              : "/api/openai/v1/models";
          const discovered = await app.request(listPath);
          assert.strictEqual(discovered.status, 200);
          const listed = (await discovered.json()) as {
            data: { id: string }[];
          };
          const id = listed.data[0].id;
          assert.strictEqual(id, model.id);
          assert.strictEqual(requests, 0);

          const schema = {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          };
          const history: any[] = [
            { role: "user", content: "Echo CONNECTED using the probe tool." },
          ];
          for (let round = 0; round < 2; round++) {
            const body =
              protocol === "responses"
                ? {
                    model: id,
                    stream,
                    input: history,
                    tools: [
                      {
                        type: "function",
                        name: "echo_probe",
                        parameters: schema,
                      },
                    ],
                  }
                : protocol === "chat"
                  ? {
                      model: id,
                      stream,
                      messages: history,
                      tools: [
                        {
                          type: "function",
                          function: { name: "echo_probe", parameters: schema },
                        },
                      ],
                    }
                  : {
                      model: id,
                      stream,
                      max_tokens: 128,
                      messages: history,
                      tools: [{ name: "echo_probe", input_schema: schema }],
                    };
            const endpoint =
              protocol === "anthropic"
                ? "/api/anthropic/v1/messages"
                : `/api/openai/v1/${protocol === "chat" ? "chat/completions" : "responses"}`;
            const response = await app.request(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            assert.strictEqual(response.status, 200);
            let result: any;
            if (!stream) {
              result = await response.json();
            } else {
              const events = (await response.text())
                .split("\n")
                .filter(
                  (line) =>
                    line.startsWith("data: ") && line !== "data: [DONE]",
                )
                .map((line) => JSON.parse(line.slice(6)));
              if (protocol === "responses") {
                result = events.find(
                  (event) => event.type === "response.completed",
                )?.response;
              } else if (protocol === "chat") {
                assert.ok(events.every((event) => event.model === id));
                const delta = events
                  .flatMap((event) => event.choices)
                  .map((choice) => choice.delta);
                const calls = delta.flatMap((part) => part.tool_calls ?? []);
                result = {
                  model: id,
                  choices: [
                    {
                      message: {
                        content: delta
                          .map((part) => part.content ?? "")
                          .join(""),
                        tool_calls: calls,
                      },
                    },
                  ],
                };
              } else {
                const content = events
                  .filter((event) => event.type === "content_block_start")
                  .map((event) => {
                    const block = event.content_block;
                    if (block.type === "tool_use") {
                      const input = events
                        .filter(
                          (delta) =>
                            delta.type === "content_block_delta" &&
                            delta.index === event.index &&
                            delta.delta.type === "input_json_delta",
                        )
                        .map((delta) => delta.delta.partial_json)
                        .join("");
                      if (input) {
                        block.input = JSON.parse(input);
                      }
                    }
                    return block;
                  });
                result = {
                  model: events.find((event) => event.type === "message_start")
                    ?.message.model,
                  content,
                  text: events
                    .filter(
                      (event) =>
                        event.type === "content_block_delta" &&
                        event.delta.type === "text_delta",
                    )
                    .map((event) => event.delta.text)
                    .join(""),
                };
              }
            }
            assert.strictEqual(result.model, id);
            if (round === 0) {
              if (protocol === "responses") {
                const call = result.output.find(
                  (item: any) => item.type === "function_call",
                );
                assert.strictEqual(call.name, "echo_probe");
                history.push(...result.output, {
                  type: "function_call_output",
                  call_id: call.call_id,
                  output: "CONNECTED",
                });
              } else if (protocol === "chat") {
                const call = result.choices[0].message.tool_calls[0];
                assert.strictEqual(call.function.name, "echo_probe");
                history.push(
                  { role: "assistant", content: null, tool_calls: [call] },
                  { role: "tool", tool_call_id: call.id, content: "CONNECTED" },
                );
              } else {
                const call = result.content.find(
                  (item: any) => item.type === "tool_use",
                );
                assert.strictEqual(call.name, "echo_probe");
                assert.deepStrictEqual(call.input, { text: "CONNECTED" });
                history.push(
                  { role: "assistant", content: [call] },
                  {
                    role: "user",
                    content: [
                      {
                        type: "tool_result",
                        tool_use_id: call.id,
                        content: "CONNECTED",
                      },
                    ],
                  },
                );
              }
            } else {
              const text =
                protocol === "responses"
                  ? result.output
                      .flatMap((item: any) => item.content ?? [])
                      .map((part: any) => part.text ?? "")
                      .join("")
                  : protocol === "chat"
                    ? result.choices[0].message.content
                    : stream
                      ? result.text
                      : result.content
                          .map((part: any) => part.text ?? "")
                          .join("");
              assert.strictEqual(text, "CONNECTED");
            }
          }
          assert.strictEqual(requests, 2);
        } finally {
          chatModelsCache.getChatModels = original;
        }
      });
    }
  }
});
