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

suite("Normalized history through official SDKs", () => {
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
