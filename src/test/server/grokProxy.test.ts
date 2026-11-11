import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import OpenAI from "openai";
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
          chatModelsCache.getChatModels = async () => [
            {
              ...model,
              id: "gpt-decoy",
              family: "gpt",
              sendRequest: async () => {
                throw new Error("Wrong model selected");
              },
            },
            model,
          ];
          const app = new OpenAPIHono();
          const openaiRoutes = new OpenAPIHono();
          registerOpenaiRoutes(openaiRoutes);
          app.route("/api/openai", openaiRoutes);
          const anthropicRoutes = new OpenAPIHono();
          registerAnthropicRoutes(anthropicRoutes);
          app.route("/api/anthropic", anthropicRoutes);
          const fetch = async (
            input: string | URL | Request,
            init?: RequestInit,
          ) => app.request(new Request(input, init));
          const openai = new OpenAI({
            apiKey: "test",
            baseURL: "http://localhost/api/openai/v1",
            maxRetries: 0,
            fetch,
          });
          const anthropic = new Anthropic({
            apiKey: "test",
            baseURL: "http://localhost/api/anthropic",
            maxRetries: 0,
            fetch,
          });
          const listed =
            protocol === "anthropic"
              ? await anthropic.models.list()
              : await openai.models.list();
          const id = listed.data.find((entry) => entry.id === model.id)?.id;
          assert.strictEqual(id, model.id);
          assert.strictEqual(requests, 0);
          const schema = {
            type: "object" as const,
            properties: { text: { type: "string" } },
            required: ["text"],
          };

          if (protocol === "chat") {
            const messages: OpenAI.ChatCompletionMessageParam[] = [
              { role: "user", content: "Echo CONNECTED with the probe tool." },
            ];
            for (let round = 0; round < 2; round++) {
              const params: OpenAI.ChatCompletionCreateParamsNonStreaming = {
                model: id,
                messages,
                tools: [
                  {
                    type: "function",
                    function: { name: "echo_probe", parameters: schema },
                  },
                ],
              };
              const response = stream
                ? await openai.chat.completions
                    .stream({ ...params, stream: true })
                    .finalChatCompletion()
                : await openai.chat.completions.create(params);
              assert.strictEqual(response.model, id);
              const message = response.choices[0].message;
              if (round === 0) {
                const call = message.tool_calls?.[0];
                assert.ok(call?.type === "function");
                assert.strictEqual(call.function.name, "echo_probe");
                assert.deepStrictEqual(JSON.parse(call.function.arguments), {
                  text: "CONNECTED",
                });
                messages.push(message, {
                  role: "tool",
                  tool_call_id: call.id,
                  content: "CONNECTED",
                });
              } else {
                assert.strictEqual(message.content, "CONNECTED");
              }
            }
          } else if (protocol === "responses") {
            const input: OpenAI.Responses.ResponseInput = [
              { role: "user", content: "Echo CONNECTED with the probe tool." },
            ];
            for (let round = 0; round < 2; round++) {
              const params: OpenAI.Responses.ResponseCreateParamsNonStreaming =
                {
                  model: id,
                  input,
                  tools: [
                    {
                      type: "function",
                      name: "echo_probe",
                      parameters: schema,
                      strict: false,
                    },
                  ],
                };
              const response = stream
                ? await openai.responses
                    .stream({ ...params, stream: true })
                    .finalResponse()
                : await openai.responses.create(params);
              assert.strictEqual(response.model, id);
              if (round === 0) {
                const call = response.output.find(
                  (item) => item.type === "function_call",
                );
                assert.ok(call?.type === "function_call");
                assert.strictEqual(call.name, "echo_probe");
                assert.deepStrictEqual(JSON.parse(call.arguments), {
                  text: "CONNECTED",
                });
                input.push(call, {
                  type: "function_call_output",
                  call_id: call.call_id,
                  output: "CONNECTED",
                });
              } else {
                assert.strictEqual(response.output_text, "CONNECTED");
              }
            }
          } else {
            const messages: Anthropic.MessageParam[] = [
              { role: "user", content: "Echo CONNECTED with the probe tool." },
            ];
            for (let round = 0; round < 2; round++) {
              const params: Anthropic.MessageCreateParamsNonStreaming = {
                model: id,
                max_tokens: 128,
                messages,
                tools: [{ name: "echo_probe", input_schema: schema }],
              };
              const response = stream
                ? await anthropic.messages.stream(params).finalMessage()
                : await anthropic.messages.create(params);
              assert.strictEqual(response.model, id);
              if (round === 0) {
                const call = response.content.find(
                  (item) => item.type === "tool_use",
                );
                assert.ok(call?.type === "tool_use");
                assert.strictEqual(call.name, "echo_probe");
                assert.deepStrictEqual(call.input, { text: "CONNECTED" });
                messages.push(
                  { role: "assistant", content: response.content },
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
              } else {
                assert.strictEqual(
                  response.content
                    .filter((item) => item.type === "text")
                    .map((item) => item.text)
                    .join(""),
                  "CONNECTED",
                );
              }
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
