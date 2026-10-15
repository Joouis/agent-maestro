import * as assert from "assert";
import * as vscode from "vscode";

import {
  ThinkingPart,
  detectThinkingRuntime,
  getThinkingRuntime,
} from "../../server/utils/languageModelThinking";
import { extractOpenAIResponsesUsage } from "../../server/utils/openai";
import {
  CUSTOM_TOOL_INPUT_SCHEMA,
  ProviderReasoningError,
  ResponsesReasoningError,
  buildResponseOutput,
  buildResponseOutputFromParts,
  convertInputContentToVSCodePart,
  convertResponsesInputToVSCode,
  convertResponsesItemToVSCode,
  convertResponsesToolsToVSCode,
  convertToolChoice,
  customToolCallInput,
  extractAdditionalTools,
  generateFunctionCallId,
  generateMessageId,
  generateResponseId,
  narrowToolsForChoice,
  restoreReasoningPart,
  thinkingToResponseReasoning,
} from "../../server/utils/openaiResponses";
import { toolHistoryToVSCode } from "../../server/utils/toolResultPairing";
import { logger } from "../../utils/logger";

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

suite("OpenAI Responses Conversion Utils Test Suite", () => {
  suite("Encrypted reasoning", () => {
    test("records current AM ordering of thinking, call, text, call", () => {
      const runtime = getThinkingRuntime()!;
      const thinking = new runtime.Thinking("", "provider-state", {
        encrypted_content: "opaque-state",
        vscode_thinking_origin_api: "responses",
      });
      const call = (id: string) => ({
        kind: "call" as const,
        id,
        name: "lookup",
        input: {},
        value: {},
        toolType: "function",
      });
      const result = (id: string) => ({
        kind: "result" as const,
        id,
        parts: [new vscode.LanguageModelTextPart("ok")],
        value: "ok",
        toolType: "function",
      });
      // This captures current AM ordering; provider acceptance is a separate check.
      const messages = toolHistoryToVSCode(
        [
          {
            role: "assistant",
            parts: [
              { kind: "reasoning", part: thinking },
              call("first"),
              {
                kind: "content",
                parts: [new vscode.LanguageModelTextPart("between")],
              },
              call("second"),
            ],
          },
          { role: "user", parts: [result("first"), result("second")] },
        ],
        "Responses",
      );
      assert.strictEqual(messages.length, 2);
      assert.strictEqual(messages[0].content[0], thinking);
      assert.deepStrictEqual(
        messages[0].content.map((part) => {
          if (part instanceof runtime.Thinking) {
            return "thinking";
          }
          if (part instanceof vscode.LanguageModelToolCallPart) {
            return part.callId;
          }
          return (part as vscode.LanguageModelTextPart).value;
        }),
        ["thinking", "first", "between", "second"],
      );
      assert.deepStrictEqual(
        messages[1].content.map(
          (part) => (part as vscode.LanguageModelToolResultPart).callId,
        ),
        ["first", "second"],
      );
    });
    test("retains opaque state through a normalized tool continuation", () => {
      const input = [
        { role: "user" as const, content: "Read status" },
        {
          type: "reasoning" as const,
          id: "rs_provider",
          summary: [],
          encrypted_content: "opaque-state",
        },
        {
          type: "function_call" as const,
          call_id: "lookup",
          name: "lookup",
          arguments: "{}",
        },
        {
          type: "function_call_output" as const,
          call_id: "lookup",
          output: "ready",
        },
      ];
      const snapshot = structuredClone(input);
      const messages = convertResponsesInputToVSCode(input);
      const parts = messages.flatMap(({ content }) => content);
      const reasoning = parts.find(
        (part) => part instanceof getThinkingRuntime()!.Thinking,
      ) as unknown as ThinkingPart;
      assert.ok(reasoning);
      assert.strictEqual(reasoning.value, "");
      assert.strictEqual(reasoning.id, "rs_provider");
      assert.strictEqual(reasoning.metadata?.encrypted_content, "opaque-state");
      const calls = parts.filter(
        (part) => part instanceof vscode.LanguageModelToolCallPart,
      );
      const results = parts.filter(
        (part) => part instanceof vscode.LanguageModelToolResultPart,
      );
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(results.length, 1);
      assert.strictEqual(calls[0].callId, results[0].callId);
      assert.deepStrictEqual(input, snapshot);
    });

    test("diagnoses summary-only reasoning and rejects malformed encrypted input", () => {
      const debug: string[] = [],
        warnings: string[] = [];
      const oldDebug = logger.debug,
        oldWarn = logger.warn;
      logger.debug = (message) => {
        debug.push(message);
      };
      logger.warn = (message) => {
        warnings.push(message);
      };
      try {
        assert.strictEqual(
          convertResponsesItemToVSCode({
            type: "reasoning",
            id: "summary",
            summary: [],
          }),
          null,
        );
        for (const item of [
          { type: "reasoning", id: "rs_empty", encrypted_content: "" },
          { type: "reasoning", id: 1, encrypted_content: "opaque" },
        ]) {
          assert.throws(
            () => convertResponsesItemToVSCode(item as any),
            ResponsesReasoningError,
          );
        }
        assert.match(debug[0], /summary-only/);
        assert.strictEqual(warnings.length, 2);
        assert.ok(!JSON.stringify(warnings).includes("opaque"));
      } finally {
        logger.debug = oldDebug;
        logger.warn = oldWarn;
      }
    });

    test("replays Codex opaque state without an ID preserving the original provider ID", () => {
      const part = new (getThinkingRuntime()!.Thinking)("", "provider-id", {
        encrypted_content: "opaque",
        vscode_thinking_origin_api: "responses",
      });
      const { id: _id, ...item } = thinkingToResponseReasoning(part)!;
      const converted = convertResponsesInputToVSCode([item, item] as any);
      assert.strictEqual(converted.length, 1);
      const restored = converted[0].content[0] as unknown as ThinkingPart;
      assert.strictEqual(restored.id, "provider-id");
      assert.strictEqual(restored.metadata?.encrypted_content, "opaque");
      const again = convertResponsesItemToVSCode(item as any)!
        .content[0] as unknown as ThinkingPart;
      assert.strictEqual(restored.id, again.id);
      assert.throws(
        () =>
          convertResponsesItemToVSCode({
            type: "reasoning",
            summary: [],
            encrypted_content: "am_reasoning_v1:broken",
          } as any),
        ResponsesReasoningError,
      );
    });

    test("reasoning between parallel calls does not break call/result pairing", () => {
      const result = convertResponsesInputToVSCode([
        { type: "function_call", call_id: "a", name: "first", arguments: "{}" },
        {
          type: "reasoning",
          id: "rs_parallel",
          summary: [],
          encrypted_content: "opaque",
        },
        {
          type: "function_call",
          call_id: "b",
          name: "second",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "a", output: "first" },
        { type: "function_call_output", call_id: "b", output: "second" },
      ]);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(
        result[0].content.filter(
          (part) => part instanceof vscode.LanguageModelToolCallPart,
        ).length,
        2,
      );
      assert.strictEqual(
        result[1].content.filter(
          (part) => part instanceof vscode.LanguageModelToolResultPart,
        ).length,
        2,
      );
      assert.ok(
        result[0].content.some(
          (part) => part instanceof getThinkingRuntime()!.Thinking,
        ),
      );
      assert.deepStrictEqual(
        result[0].content.map((part) =>
          part instanceof vscode.LanguageModelToolCallPart
            ? part.callId
            : "reasoning",
        ),
        ["a", "reasoning", "b"],
      );
    });

    test("preserves assistant boundaries and alternating reasoning/call order", () => {
      const r = (id: string) => ({
        type: "reasoning" as const,
        id,
        summary: [],
        encrypted_content: `state-${id}`,
      });
      const c = (id: string) => ({
        type: "function_call" as const,
        call_id: id,
        name: id,
        arguments: "{}",
      });
      const o = (id: string) => ({
        type: "function_call_output" as const,
        call_id: id,
        output: "ok",
      });
      const result = convertResponsesInputToVSCode([
        { role: "assistant", content: "A" },
        r("R1"),
        c("C1"),
        r("R2"),
        c("C2"),
        o("C1"),
        o("C2"),
      ]);
      assert.strictEqual(result.length, 3);
      assert.strictEqual(
        (result[0].content[0] as vscode.LanguageModelTextPart).value,
        "A",
      );
      assert.deepStrictEqual(
        result[1].content.map((part) =>
          part instanceof vscode.LanguageModelToolCallPart
            ? part.callId
            : (part as unknown as ThinkingPart).id,
        ),
        ["R1", "C1", "R2", "C2"],
      );
    });

    test("round-trips source-ordered output with assistant text between pending tool calls", () => {
      for (const includeThinking of [false, true]) {
        const thinking = new (getThinkingRuntime()!.Thinking)(
          "",
          "rs_roundtrip",
          {
            encrypted_content: "opaque-roundtrip",
            vscode_thinking_origin_api: "responses",
          },
        );
        const output = buildResponseOutputFromParts(
          [
            new vscode.LanguageModelTextPart("Before"),
            new vscode.LanguageModelToolCallPart("first", "lookup", {}),
            ...(includeThinking ? [thinking] : []),
            new vscode.LanguageModelTextPart("Between"),
            new vscode.LanguageModelToolCallPart("second", "lookup", {}),
            new vscode.LanguageModelTextPart("After"),
          ],
          new Map(),
        );
        const input = [
          ...output,
          {
            type: "function_call_output" as const,
            call_id: "second",
            output: "B",
          },
          {
            type: "function_call_output" as const,
            call_id: "first",
            output: "A",
          },
        ];
        const snapshot = structuredClone(input);
        const messages = convertResponsesInputToVSCode(input);
        assert.deepStrictEqual(
          messages.flatMap(({ content }) =>
            content.map((part) => {
              if (part instanceof vscode.LanguageModelToolCallPart) {
                return `call:${part.callId}`;
              }
              if (part instanceof vscode.LanguageModelToolResultPart) {
                return `result:${part.callId}`;
              }
              if (part instanceof vscode.LanguageModelTextPart) {
                return part.value;
              }
              return (part as unknown as ThinkingPart).id;
            }),
          ),
          [
            "Before",
            "call:first",
            ...(includeThinking ? ["rs_roundtrip"] : []),
            "Between",
            "call:second",
            "After",
            "result:second",
            "result:first",
          ],
        );
        assert.deepStrictEqual(input, snapshot);
      }
    });

    test("does not pair reasoning tool history across empty independent messages", () => {
      for (const role of ["user", "developer", "system"] as const) {
        const messages = convertResponsesInputToVSCode([
          {
            type: "reasoning",
            id: "rs_boundary",
            summary: [],
            encrypted_content: "opaque",
          },
          {
            type: "function_call",
            call_id: "call_boundary",
            name: "lookup",
            arguments: "{}",
          },
          { role, content: [] },
          {
            type: "function_call_output",
            call_id: "call_boundary",
            output: "ready",
          },
        ]);
        const parts = messages.flatMap(({ content }) => content);
        assert.ok(
          !parts.some(
            (part) => part instanceof vscode.LanguageModelToolCallPart,
          ),
        );
        assert.ok(
          !parts.some(
            (part) => part instanceof vscode.LanguageModelToolResultPart,
          ),
        );
      }
    });

    test("keeps new-turn reasoning after completed tool results and respects user boundaries", () => {
      const call = (id: string) => ({
        type: "function_call" as const,
        call_id: id,
        name: id,
        arguments: "{}",
      });
      const result = (id: string) => ({
        type: "function_call_output" as const,
        call_id: id,
        output: "ready",
      });
      const reasoning = (id: string) => ({
        type: "reasoning" as const,
        id,
        summary: [],
        encrypted_content: `state-${id}`,
      });
      const messages = convertResponsesInputToVSCode([
        call("first"),
        result("first"),
        reasoning("second-state"),
        call("second"),
        result("second"),
        { role: "user", content: "Next task" },
        reasoning("third-state"),
        call("third"),
        result("third"),
      ]);
      const labels = messages.map(({ content }) =>
        content.map((part) => {
          if (part instanceof vscode.LanguageModelToolCallPart) {
            return `call:${part.callId}`;
          }
          if (part instanceof vscode.LanguageModelToolResultPart) {
            return `result:${part.callId}`;
          }
          if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
          }
          return (part as unknown as ThinkingPart).id;
        }),
      );
      assert.deepStrictEqual(labels, [
        ["call:first"],
        ["result:first"],
        ["second-state", "call:second"],
        ["result:second"],
        ["Next task"],
        ["third-state", "call:third"],
        ["result:third"],
      ]);
    });

    test("detects absent and throwing runtimes and rejects unavailable replay", () => {
      assert.strictEqual(detectThinkingRuntime({}), undefined);
      assert.strictEqual(
        detectThinkingRuntime({
          get LanguageModelThinkingPart() {
            throw new Error("private failure");
          },
        }),
        undefined,
      );
      assert.throws(
        () =>
          restoreReasoningPart(
            {
              type: "reasoning",
              id: "rs",
              summary: [],
              encrypted_content: "opaque",
            },
            undefined,
          ),
        (error: unknown) => {
          assert.ok(error instanceof ResponsesReasoningError);
          assert.strictEqual(error.code, "reasoning_unavailable");
          assert.match(error.message, /does not expose the thinking runtime/);
          assert.match(error.message, /updating VS Code and GitHub Copilot/);
          assert.match(
            error.message,
            /start a new session without this reasoning history/,
          );
          assert.match(error.message, /VS Code 1\.141\.2 \/ Copilot 0\.69\.0/);
          assert.match(error.message, /not guaranteed/);
          assert.ok(!error.message.includes("opaque"));
          return true;
        },
      );
    });

    test("deduplicates reasoning IDs and rejects conflicting encrypted state", () => {
      const runtime = getThinkingRuntime()!;
      const part = new runtime.Thinking("", "rs_same", {
        encrypted_content: "state",
        vscode_thinking_origin_api: "responses",
      });
      assert.strictEqual(
        buildResponseOutputFromParts([part, part], new Map()).length,
        1,
      );
      const conflict = new runtime.Thinking("", "rs_same", {
        encrypted_content: "different",
        vscode_thinking_origin_api: "responses",
      });
      assert.throws(
        () => buildResponseOutputFromParts([part, conflict], new Map()),
        ProviderReasoningError,
      );
      const item = {
        type: "reasoning" as const,
        id: "rs_same",
        encrypted_content: "state",
        summary: [],
      };
      assert.strictEqual(convertResponsesInputToVSCode([item, item]).length, 1);
      assert.throws(
        () =>
          convertResponsesInputToVSCode([
            item,
            { ...item, encrypted_content: "different" },
          ]),
        ResponsesReasoningError,
      );
    });

    test("replays the provider ID from opaque state when a client rewrites outer IDs", () => {
      const runtime = getThinkingRuntime()!;
      const original = new runtime.Thinking("", "original-provider-id", {
        encrypted_content: "original-provider-ciphertext",
        vscode_thinking_origin_api: "responses",
      });
      const output = thinkingToResponseReasoning(original)!;
      const rewritten = { ...output, id: "client-item-id" };
      const restored = convertResponsesItemToVSCode(rewritten)!
        .content[0] as unknown as ThinkingPart;
      assert.strictEqual(restored.id, original.id);
      assert.strictEqual(
        restored.metadata?.encrypted_content,
        original.metadata?.encrypted_content,
      );
      const history = convertResponsesInputToVSCode([output, rewritten]);
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0].content.length, 1);
    });

    test("rejects hosts that discard or rewrite encrypted reasoning state", () => {
      const runtime = getThinkingRuntime()!;
      const originalThinking = runtime.Thinking;
      const originalWarn = logger.warn;
      const warnings: string[] = [];
      logger.warn = (message) => {
        warnings.push(message);
      };
      try {
        for (const failure of ["metadata", "id", "ciphertext", "origin"]) {
          runtime.Thinking = class {
            readonly id?: string;
            readonly metadata: Readonly<Record<string, unknown>>;
            constructor(
              readonly value: string | string[],
              id?: string,
              metadata?: Readonly<Record<string, unknown>>,
            ) {
              this.id = failure === "id" ? "rewritten" : id;
              this.metadata =
                failure === "metadata"
                  ? {}
                  : {
                      ...metadata,
                      ...(failure === "ciphertext" && {
                        encrypted_content: "rewritten",
                      }),
                      ...(failure === "origin" && {
                        vscode_thinking_origin_api: "messages",
                      }),
                    };
            }
          };
          assert.throws(
            () =>
              convertResponsesInputToVSCode([
                {
                  type: "reasoning",
                  id: "provider-id",
                  summary: [],
                  encrypted_content: "private-ciphertext",
                },
              ]),
            (error: unknown) => {
              assert.ok(error instanceof ResponsesReasoningError);
              assert.strictEqual(error.code, "reasoning_unavailable");
              assert.ok(!error.message.includes("private-ciphertext"));
              return true;
            },
          );
        }
        assert.strictEqual(warnings.length, 4);
        assert.ok(
          warnings.every((message) => !message.includes("private-ciphertext")),
        );
      } finally {
        runtime.Thinking = originalThinking;
        logger.warn = originalWarn;
      }
    });

    test("only serializes Responses-origin ciphertext, never private thinking text", () => {
      for (const metadata of [
        undefined,
        { encrypted_content: "opaque" },
        { encrypted_content: "opaque", vscode_thinking_origin_api: "messages" },
      ]) {
        const part = new (getThinkingRuntime()!.Thinking)(
          "private-text",
          "rs_provider",
          metadata,
        );
        assert.strictEqual(thinkingToResponseReasoning(part), undefined);
      }
      const part = new (getThinkingRuntime()!.Thinking)(
        "private-text",
        "rs_provider",
        {
          encrypted_content: "opaque",
          vscode_thinking_origin_api: "responses",
        },
      );
      const output = buildResponseOutputFromParts(
        [
          new vscode.LanguageModelTextPart("before"),
          part,
          new vscode.LanguageModelToolCallPart("call", "lookup", {}),
          new vscode.LanguageModelTextPart("after"),
        ],
        new Map(),
      );
      assert.deepStrictEqual(
        output.map(({ type }) => type),
        ["message", "reasoning", "function_call", "message"],
      );
      assert.ok(!JSON.stringify(output).includes("private-text"));
      const restored = convertResponsesItemToVSCode(output[1] as any)!
        .content[0] as unknown as ThinkingPart;
      assert.strictEqual(restored.id, "rs_provider");
      assert.strictEqual(restored.metadata?.encrypted_content, "opaque");
    });
  });
  suite("ID Generation Functions", () => {
    test("generateResponseId should return string starting with resp_AM-", () => {
      const id = generateResponseId();
      assert.ok(id.startsWith("resp_AM-"));
    });

    test("generateMessageId should return string starting with msg_AM-", () => {
      const id = generateMessageId();
      assert.ok(id.startsWith("msg_AM-"));
    });

    test("generateFunctionCallId should return string starting with fc_AM-", () => {
      const id = generateFunctionCallId();
      assert.ok(id.startsWith("fc_AM-"));
    });

    test("generated IDs should be unique", () => {
      const ids = new Set([
        generateResponseId(),
        generateResponseId(),
        generateMessageId(),
        generateMessageId(),
      ]);
      assert.strictEqual(ids.size, 4);
    });
  });

  suite("convertInputContentToVSCodePart", () => {
    test("should convert input_text to TextPart", () => {
      const content = { type: "input_text" as const, text: "Hello world" };
      const result = convertInputContentToVSCodePart(content);
      assert.ok(result instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        (result as vscode.LanguageModelTextPart).value,
        "Hello world",
      );
    });

    test("should convert input_image with base64 data URI to DataPart", () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const content = {
        type: "input_image" as const,
        image_url: `data:image/png;base64,${base64Data}`,
        detail: "auto" as const,
      };
      const result = convertInputContentToVSCodePart(content);
      assert.ok(result instanceof vscode.LanguageModelDataPart);
    });

    test("should handle input_image with URL by falling back to JSON", () => {
      const content = {
        type: "input_image" as const,
        image_url: "https://example.com/image.png",
        detail: "auto" as const,
      };
      const result = convertInputContentToVSCodePart(content);
      assert.ok(result instanceof vscode.LanguageModelTextPart);
    });

    test("should handle input_file by falling back to JSON", () => {
      const content = {
        type: "input_file" as const,
        file_id: "file-123",
      };
      const result = convertInputContentToVSCodePart(content);
      assert.ok(result instanceof vscode.LanguageModelTextPart);
    });

    test("should drop encrypted_content to an empty text part", () => {
      const content = {
        type: "encrypted_content",
        data: "gAAAAABm..ciphertext..",
      } as any;
      const result = convertInputContentToVSCodePart(content);
      assert.ok(result instanceof vscode.LanguageModelTextPart);
      assert.strictEqual((result as vscode.LanguageModelTextPart).value, "");
    });

    test("should handle unknown content type by falling back to JSON", () => {
      const content = { type: "unknown_type", data: "test" } as any;
      const result = convertInputContentToVSCodePart(content);
      assert.ok(result instanceof vscode.LanguageModelTextPart);
    });
  });

  suite("convertResponsesItemToVSCode", () => {
    test("should convert EasyInputMessage with string content (user)", () => {
      const item = { role: "user" as const, content: "Hello" };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert EasyInputMessage with string content (assistant)", () => {
      const item = { role: "assistant" as const, content: "Hi there" };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should convert EasyInputMessage with string content (system)", () => {
      const item = { role: "system" as const, content: "You are helpful" };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert EasyInputMessage with string content (developer)", () => {
      const item = { role: "developer" as const, content: "Instructions" };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert EasyInputMessage with array content", () => {
      const item = {
        role: "user" as const,
        content: [{ type: "input_text" as const, text: "Hello" }],
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert InputMessage with type: message", () => {
      const item = {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text: "Hello" }],
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert function_call item", () => {
      const item = {
        type: "function_call" as const,
        id: "fc_123",
        call_id: "call_123",
        name: "get_weather",
        arguments: '{"city": "NYC"}',
        status: "completed" as const,
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should handle function_call with invalid arguments JSON", () => {
      const item = {
        type: "function_call" as const,
        id: "fc_123",
        call_id: "call_123",
        name: "get_weather",
        arguments: "invalid json {{{",
        status: "completed" as const,
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
    });

    test("should re-encode namespaced function_call name on replay", () => {
      const item = {
        type: "function_call" as const,
        id: "fc_123",
        call_id: "call_1",
        namespace: "collaboration",
        name: "spawn_agent",
        arguments: "{}",
        status: "completed" as const,
      };
      const result = convertResponsesItemToVSCode(item as any);
      const part = (result!.content as any[])[0];
      assert.strictEqual(part.name, "collaboration__spawn_agent");
    });

    test("should convert function_call_output item", () => {
      const item = {
        type: "function_call_output" as const,
        call_id: "call_123",
        output: '{"temperature": 72}',
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should preserve function_call_output images as DataPart", () => {
      const item = {
        type: "function_call_output" as const,
        call_id: "call_view_image_1",
        output: [
          { type: "input_text" as const, text: "screenshot.png" },
          {
            type: "input_image" as const,
            image_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            detail: "high" as const,
          },
        ],
      };
      const result = convertResponsesItemToVSCode(item as any);
      const toolResult = (result!.content as any[])[0];
      assert.ok(toolResult.content[0] instanceof vscode.LanguageModelTextPart);
      assert.ok(toolResult.content[1] instanceof vscode.LanguageModelDataPart);
    });

    test("should convert custom_tool_call item", () => {
      const item = {
        type: "custom_tool_call" as const,
        id: "ctc_123",
        call_id: "call_exec_1",
        name: "exec",
        input: "await tools.exec_command({ cmd: 'pwd' })",
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
      const part = (result!.content as any[])[0];
      assert.strictEqual(part.callId, "call_exec_1");
      assert.strictEqual(part.name, "exec");
      // Raw string input is wrapped so VSCode's object-typed input is satisfied.
      assert.deepStrictEqual(part.input, {
        input: "await tools.exec_command({ cmd: 'pwd' })",
      });
    });

    test("should re-encode namespaced custom_tool_call name on replay", () => {
      const item = {
        type: "custom_tool_call" as const,
        id: "ctc_123",
        call_id: "call_1",
        namespace: "collaboration",
        name: "raw_helper",
        input: "raw",
      };
      const result = convertResponsesItemToVSCode(item as any);
      const part = (result!.content as any[])[0];
      assert.strictEqual(part.name, "collaboration__raw_helper");
    });

    test("should convert custom_tool_call_output item (string output)", () => {
      const item = {
        type: "custom_tool_call_output" as const,
        call_id: "call_exec_1",
        output: "/home/user/project",
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
      const part = (result!.content as any[])[0];
      assert.strictEqual(part.callId, "call_exec_1");
    });

    test("should convert custom_tool_call_output item (array output)", () => {
      const item = {
        type: "custom_tool_call_output" as const,
        call_id: "call_exec_1",
        output: [{ type: "input_text" as const, text: "done" }],
      };
      const result = convertResponsesItemToVSCode(item);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
      const toolResult = (result!.content as any[])[0];
      assert.ok(toolResult.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(toolResult.content[0].value, "done");
    });

    test("should handle undefined values in tool output", () => {
      const scalarResult = convertResponsesItemToVSCode({
        type: "custom_tool_call_output",
        call_id: "call_exec_1",
        output: undefined,
      } as any);
      const arrayResult = convertResponsesItemToVSCode({
        type: "custom_tool_call_output",
        call_id: "call_exec_2",
        output: [undefined],
      } as any);

      assert.strictEqual(
        ((scalarResult!.content as any[])[0].content[0] as any).value,
        "",
      );
      assert.strictEqual(
        ((arrayResult!.content as any[])[0].content[0] as any).value,
        "",
      );
    });

    test("should serialize malformed typed tool output parts as JSON", () => {
      const malformedImage = { type: "input_image", image_url: 42 };
      const malformedText = { type: "input_text", text: { value: "done" } };
      const result = convertResponsesItemToVSCode({
        type: "custom_tool_call_output",
        call_id: "call_exec_1",
        output: [malformedImage, malformedText],
      } as any);
      const toolResult = (result!.content as any[])[0];

      assert.strictEqual(
        toolResult.content[0].value,
        JSON.stringify(malformedImage),
      );
      assert.strictEqual(
        toolResult.content[1].value,
        JSON.stringify(malformedText),
      );
    });

    test("should preserve custom_tool_call_output images as DataPart", () => {
      const item = {
        type: "custom_tool_call_output" as const,
        call_id: "call_view_image_1",
        output: [
          { type: "input_text" as const, text: "Viewed an image" },
          {
            type: "input_image" as const,
            image_url:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            detail: "high" as const,
          },
        ],
      };
      const result = convertResponsesItemToVSCode(item as any);
      const toolResult = (result!.content as any[])[0];
      assert.ok(toolResult.content[0] instanceof vscode.LanguageModelTextPart);
      assert.ok(toolResult.content[1] instanceof vscode.LanguageModelDataPart);
    });

    test("should return null for additional_tools item", () => {
      const item = {
        type: "additional_tools" as const,
        role: "developer" as const,
        tools: [{ type: "custom" as const, name: "exec" }],
      };
      const result = convertResponsesItemToVSCode(item as any);
      assert.strictEqual(result, null);
    });

    test("should convert agent_message into a tagged User message", () => {
      const item = {
        type: "agent_message" as const,
        author: "/root/second_review",
        recipient: "/root",
        content: [{ type: "input_text" as const, text: "review done" }],
      };
      const result = convertResponsesItemToVSCode(item as any);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
      const parts = result!.content as vscode.LanguageModelTextPart[];
      assert.ok(
        parts[0].value.includes("/root/second_review") &&
          parts[0].value.includes("/root"),
      );
      assert.strictEqual(parts[1].value, "review done");
    });

    test("should handle agent_message without content", () => {
      const item = { type: "agent_message" as const, author: "/root" };
      const result = convertResponsesItemToVSCode(item as any);
      assert.ok(result);
      assert.strictEqual(
        result!.role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should return null for item_reference", () => {
      const item = { type: "item_reference" as const, id: "ref_123" };
      const result = convertResponsesItemToVSCode(item);
      assert.strictEqual(result, null);
    });

    test("should return null for null input", () => {
      const result = convertResponsesItemToVSCode(null as any);
      assert.strictEqual(result, null);
    });

    test("should return null for undefined input", () => {
      const result = convertResponsesItemToVSCode(undefined as any);
      assert.strictEqual(result, null);
    });
  });

  suite("convertResponsesInputToVSCode", () => {
    const toolCallParts = (
      message: vscode.LanguageModelChatMessage,
    ): vscode.LanguageModelToolCallPart[] =>
      message.content as vscode.LanguageModelToolCallPart[];

    const toolResultParts = (
      message: vscode.LanguageModelChatMessage,
    ): vscode.LanguageModelToolResultPart[] =>
      message.content as vscode.LanguageModelToolResultPart[];

    test("should handle string input", () => {
      const result = convertResponsesInputToVSCode("Hello world");
      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should handle string input with instruction", () => {
      const result = convertResponsesInputToVSCode("Hello", "Be helpful");
      assert.strictEqual(result.length, 2);
    });

    test("should handle array input with multiple items", () => {
      const input = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi" },
        { role: "user" as const, content: "How are you?" },
      ];
      const result = convertResponsesInputToVSCode(input);
      assert.strictEqual(result.length, 3);
    });

    test("should add instruction as first message", () => {
      const input = [{ role: "user" as const, content: "Hello" }];
      const result = convertResponsesInputToVSCode(input, "System instruction");
      assert.strictEqual(result.length, 2);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should handle undefined input with instruction", () => {
      const result = convertResponsesInputToVSCode(
        undefined,
        "Just instruction",
      );
      assert.strictEqual(result.length, 1);
    });

    test("should handle empty array", () => {
      const result = convertResponsesInputToVSCode([]);
      assert.strictEqual(result.length, 0);
    });

    test("should skip null items from conversion", () => {
      const input = [
        { role: "user" as const, content: "Hello" },
        { type: "item_reference" as const, id: "ref_123" },
        { role: "user" as const, content: "World" },
      ];
      const result = convertResponsesInputToVSCode(input);
      assert.strictEqual(result.length, 2);
    });

    test("should pair parallel function outputs by call ID", () => {
      const result = convertResponsesInputToVSCode([
        {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "first",
          arguments: "{}",
        },
        {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "second",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call_b",
          output: "second result",
        },
        {
          type: "function_call_output",
          call_id: "call_a",
          output: "first result",
        },
      ]);

      const toolResults = result
        .flatMap((message) => message.content)
        .filter(
          (part) => part instanceof vscode.LanguageModelToolResultPart,
        ) as vscode.LanguageModelToolResultPart[];
      assert.deepStrictEqual(
        toolResults.map((part) => part.callId),
        ["call_b", "call_a"],
      );
    });

    test("should preserve orphaned outputs as text and drop duplicates", () => {
      const warnings: string[] = [];
      const originalWarn = logger.warn;
      logger.warn = (message: string) => warnings.push(message);

      try {
        const result = convertResponsesInputToVSCode([
          {
            type: "function_call",
            id: "fc_known",
            call_id: "call_known",
            name: "known",
            arguments: "{}",
          },
          {
            type: "custom_tool_call",
            id: "ctc_known",
            call_id: "call_custom",
            name: "shell",
            input: "pwd",
          },
          {
            type: "function_call_output",
            call_id: "call_missing",
            output: "orphaned output",
          },
          {
            type: "function_call_output",
            call_id: "call_known",
            output: "first output",
          },
          {
            type: "function_call_output",
            call_id: "call_known",
            output: "first output",
          },
          {
            type: "function_call_output",
            call_id: "call_missing",
            output: "orphaned output",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_custom",
            output: "custom output",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_custom",
            output: "custom output",
          },
        ] as any);

        assert.strictEqual(result.length, 2);
        assert.deepStrictEqual(
          toolCallParts(result[0]).map((part) => part.callId),
          ["call_known", "call_custom"],
        );
        const orphanedParts = result[1].content.filter(
          (part) => part instanceof vscode.LanguageModelTextPart,
        );
        assert.ok(orphanedParts[0] instanceof vscode.LanguageModelTextPart);
        assert.match(
          (orphanedParts[0] as vscode.LanguageModelTextPart).value,
          /call_missing/,
        );
        assert.strictEqual(
          (orphanedParts[1] as vscode.LanguageModelTextPart).value,
          "orphaned output",
        );
        const toolResults = result
          .flatMap((message) => message.content)
          .filter(
            (part) => part instanceof vscode.LanguageModelToolResultPart,
          ) as vscode.LanguageModelToolResultPart[];
        assert.deepStrictEqual(
          toolResults.map((part) => part.callId),
          ["call_known", "call_custom"],
        );
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /"orphanedResults":1/);
        assert.match(warnings[0], /"duplicateResults":3/);
      } finally {
        logger.warn = originalWarn;
      }
    });

    test("should preserve calls and outputs with invalid IDs as text", () => {
      const warnings: string[] = [];
      const originalWarn = logger.warn;
      logger.warn = (message: string) => warnings.push(message);

      try {
        const result = convertResponsesInputToVSCode([
          {
            type: "function_call",
            id: "fc_missing",
            name: "missing",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: null,
            output: "null output",
          },
          {
            type: "custom_tool_call",
            id: "ctc_number",
            call_id: 42,
            name: "number",
            input: "pwd",
          },
          {
            type: "custom_tool_call_output",
            call_id: { invalid: true },
            output: "object output",
          },
        ] as any);

        assert.strictEqual(result.length, 4);
        assert.ok(
          result
            .flatMap((message) => message.content)
            .every((part) => part instanceof vscode.LanguageModelTextPart),
        );
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /"conflictGroups":2/);
      } finally {
        logger.warn = originalWarn;
      }
    });

    test("should preserve a single custom tool call and output as paired turns", () => {
      const input = [
        {
          type: "custom_tool_call" as const,
          id: "ctc_1",
          call_id: "call_1",
          name: "exec",
          input: "pwd",
        },
        {
          type: "custom_tool_call_output" as const,
          call_id: "call_1",
          output: "/workspace",
        },
      ];

      const result = convertResponsesInputToVSCode(input);

      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(
        toolCallParts(result[0]).map((part) => part.callId),
        ["call_1"],
      );
      assert.deepStrictEqual(
        toolResultParts(result[1]).map((part) => part.callId),
        ["call_1"],
      );
    });

    test("should group parallel custom tool calls and outputs into paired turns", () => {
      const calls = Array.from({ length: 4 }, (_, index) => ({
        type: "custom_tool_call" as const,
        id: `ctc_${index}`,
        call_id: `call_${index}`,
        name: "exec",
        input: `command ${index}`,
      }));
      const outputs = Array.from({ length: 4 }, (_, index) => ({
        type: "custom_tool_call_output" as const,
        call_id: `call_${index}`,
        output: `result ${index}`,
      }));

      const result = convertResponsesInputToVSCode([...calls, ...outputs]);

      assert.strictEqual(result.length, 2);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
      assert.deepStrictEqual(
        toolCallParts(result[0]).map((part) => part.callId),
        ["call_0", "call_1", "call_2", "call_3"],
      );
      assert.strictEqual(
        result[1].role,
        vscode.LanguageModelChatMessageRole.User,
      );
      assert.deepStrictEqual(
        toolResultParts(result[1]).map((part) => part.callId),
        ["call_0", "call_1", "call_2", "call_3"],
      );
    });

    test("should group parallel function calls and outputs into paired turns", () => {
      const input = [
        {
          type: "function_call" as const,
          id: "fc_1",
          call_id: "call_weather",
          name: "get_weather",
          arguments: '{"city":"Seattle"}',
          status: "completed" as const,
        },
        {
          type: "function_call" as const,
          id: "fc_2",
          call_id: "call_time",
          name: "get_time",
          arguments: '{"timezone":"UTC"}',
          status: "completed" as const,
        },
        {
          type: "function_call_output" as const,
          call_id: "call_weather",
          output: "rainy",
        },
        {
          type: "function_call_output" as const,
          call_id: "call_time",
          output: "12:00",
        },
      ];

      const result = convertResponsesInputToVSCode(input);

      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(
        toolCallParts(result[0]).map((part) => part.callId),
        ["call_weather", "call_time"],
      );
      assert.deepStrictEqual(
        toolResultParts(result[1]).map((part) => part.callId),
        ["call_weather", "call_time"],
      );
    });

    test("should only group compatible tool turns across mixed input boundaries", () => {
      const input = [
        { role: "user" as const, content: "Run both tools" },
        {
          type: "function_call" as const,
          id: "fc_1",
          call_id: "call_function",
          namespace: "utilities",
          name: "lookup",
          arguments: "{}",
          status: "completed" as const,
        },
        {
          type: "additional_tools" as const,
          role: "developer" as const,
          tools: [{ type: "custom" as const, name: "exec" }],
        },
        {
          type: "custom_tool_call" as const,
          id: "ctc_1",
          call_id: "call_custom",
          name: "exec",
          input: "pwd",
        },
        {
          type: "function_call_output" as const,
          call_id: "call_function",
          output: "found",
        },
        {
          type: "custom_tool_call_output" as const,
          call_id: "call_custom",
          output: "/workspace",
        },
        { role: "assistant" as const, content: "Both tools completed" },
        { role: "user" as const, content: "Thanks" },
      ];

      const result = convertResponsesInputToVSCode(input as any);

      assert.strictEqual(result.length, 5);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
      assert.deepStrictEqual(
        toolCallParts(result[1]).map((part) => [part.callId, part.name]),
        [
          ["call_function", "utilities__lookup"],
          ["call_custom", "exec"],
        ],
      );
      assert.deepStrictEqual(
        toolResultParts(result[2]).map((part) => part.callId),
        ["call_function", "call_custom"],
      );
      assert.strictEqual(
        result[3].role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
      assert.strictEqual(
        result[4].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should not group tool calls across instruction and input", () => {
      const instruction = [
        {
          type: "custom_tool_call" as const,
          id: "ctc_instruction",
          call_id: "call_instruction",
          name: "exec",
          input: "first",
        },
      ];
      const input = [
        {
          type: "custom_tool_call" as const,
          id: "ctc_input",
          call_id: "call_input",
          name: "exec",
          input: "second",
        },
      ];

      const result = convertResponsesInputToVSCode(input, instruction);

      assert.strictEqual(result.length, 2);
      assert.ok(
        result.every((message) =>
          message.content.every(
            (part) => part instanceof vscode.LanguageModelTextPart,
          ),
        ),
      );
      assert.ok(
        result.every((message) =>
          message.content.some(
            (part) =>
              part instanceof vscode.LanguageModelTextPart &&
              part.value.includes("Execution status is unknown"),
          ),
        ),
      );
    });
  });

  suite("convertResponsesToolsToVSCode", () => {
    test("should convert function tool", () => {
      const tools = [
        {
          type: "function" as const,
          name: "get_weather",
          description: "Get the weather",
          parameters: { type: "object", properties: {} },
          strict: false,
        },
      ];
      const { tools: result } = convertResponsesToolsToVSCode(tools);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "get_weather");
      assert.strictEqual(result[0].description, "Get the weather");
    });

    test("should handle function without description", () => {
      const tools = [
        {
          type: "function" as const,
          name: "simple_function",
          parameters: {},
          strict: false,
        },
      ];
      const { tools: result } = convertResponsesToolsToVSCode(tools);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "simple_function");
      assert.strictEqual(result[0].description, "");
    });

    test("should declare the raw input wrapper for custom tools", () => {
      const tools = [
        {
          type: "custom" as const,
          name: "exec",
          description: "Run JavaScript",
          format: { type: "grammar" as const, syntax: "lark", definition: "" },
        },
      ];
      const { tools: result } = convertResponsesToolsToVSCode(tools as any);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "exec");
      assert.strictEqual(result[0].description, "Run JavaScript");
      assert.deepStrictEqual(result[0].inputSchema, CUSTOM_TOOL_INPUT_SCHEMA);
    });

    test("should encode namespace tools as <ns>__<name> with a toolMap", () => {
      const tools = [
        {
          type: "namespace" as const,
          name: "collaboration",
          description: "Sub-agent tools",
          tools: [
            {
              type: "function" as const,
              name: "spawn_agent",
              description: "Spawn",
              parameters: { type: "object", properties: {} },
            },
            { type: "custom" as const, name: "raw_helper", description: "Raw" },
          ],
        },
      ];
      const { tools: result, toolMap } = convertResponsesToolsToVSCode(
        tools as any,
      );
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].description, "Sub-agent tools\n\nSpawn");
      assert.strictEqual(result[1].description, "Sub-agent tools\n\nRaw");
      assert.deepStrictEqual(result[0].inputSchema, {
        type: "object",
        properties: {},
      });
      assert.deepStrictEqual(
        (result[1].inputSchema as { required: string[] }).required,
        ["input"],
      );
      assert.deepStrictEqual(
        result.map((t) => t.name),
        ["collaboration__spawn_agent", "collaboration__raw_helper"],
      );
      assert.deepStrictEqual(toolMap.get("collaboration__spawn_agent"), {
        namespace: "collaboration",
        name: "spawn_agent",
        isCustom: false,
        plaintextArguments: true,
      });
      assert.deepStrictEqual(toolMap.get("collaboration__raw_helper"), {
        namespace: "collaboration",
        name: "raw_helper",
        isCustom: true,
      });
    });

    test("should preserve whichever namespace descriptions are available", () => {
      for (const [namespaceDescription, toolDescription, expected] of [
        ["Namespace instructions", undefined, "Namespace instructions"],
        [undefined, "Tool instructions", "Tool instructions"],
        [undefined, undefined, ""],
        ["", "Tool instructions", "Tool instructions"],
      ]) {
        const { tools } = convertResponsesToolsToVSCode([
          {
            type: "namespace",
            name: "utilities",
            description: namespaceDescription,
            tools: [
              {
                type: "custom",
                name: "exec",
                description: toolDescription,
              },
            ],
          },
        ] as any);
        assert.strictEqual(tools[0].description, expected);
      }
    });

    test("should round-trip namespaced custom code using the declared wrapper", () => {
      const declarations = [
        {
          type: "namespace",
          name: "functions",
          description:
            "Discover tools through ALL_TOOLS and call tools by name.",
          tools: [
            {
              type: "custom",
              name: "exec",
              description: "Run JavaScript",
              format: { type: "text" },
            },
          ],
        },
      ];
      const snapshot = JSON.stringify(declarations);
      const { tools, toolMap } = convertResponsesToolsToVSCode(
        declarations as any,
      );
      const source = 'const message = "quoted";\ntext(message);';
      const wrappedInput = JSON.parse(JSON.stringify({ input: source }));
      const schema = tools[0].inputSchema as {
        properties: { input: { type: string } };
        required: string[];
      };
      assert.strictEqual(schema.properties.input.type, "string");
      assert.deepStrictEqual(schema.required, ["input"]);
      assert.strictEqual(
        tools[0].description,
        "Discover tools through ALL_TOOLS and call tools by name.\n\nRun JavaScript",
      );
      const [output] = buildResponseOutput(
        "",
        [{ callId: "call_exec", name: tools[0].name, input: wrappedInput }],
        toolMap,
      );
      assert.strictEqual(output.type, "custom_tool_call");
      if (output.type !== "custom_tool_call") {
        assert.fail("Expected a custom tool call");
      }
      assert.strictEqual(output.input, source);
      assert.strictEqual(output.name, "exec");
      assert.strictEqual(output.namespace, "functions");
      const replay = convertResponsesItemToVSCode(output);
      const part = replay?.content[0];
      assert.ok(part instanceof vscode.LanguageModelToolCallPart);
      assert.strictEqual(part.name, tools[0].name);
      assert.deepStrictEqual(part.input, wrappedInput);
      assert.strictEqual(JSON.stringify(declarations), snapshot);
    });

    test("should expose Codex collaboration messages as plaintext", () => {
      const parameters = {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Initial task",
            encrypted: true,
          },
          task_name: { type: "string" },
        },
        required: ["task_name", "message"],
      };
      const tools = [
        {
          type: "namespace",
          name: "collaboration",
          description: "Sub-agent tools",
          tools: [
            ...["spawn_agent", "send_message", "followup_task"].map((name) => ({
              type: "function",
              name,
              parameters,
            })),
          ],
        },
      ];

      const { tools: result, toolMap } = convertResponsesToolsToVSCode(
        tools as any,
      );
      assert.strictEqual(result.length, 3);
      for (const tool of result) {
        const inputSchema = tool.inputSchema as any;
        assert.strictEqual(inputSchema.properties.message.encrypted, undefined);
        assert.strictEqual(inputSchema.properties.message.type, "string");
        assert.strictEqual(toolMap.get(tool.name)?.plaintextArguments, true);
      }
      assert.strictEqual(
        parameters.properties.message.encrypted,
        true,
        "request schema must not be mutated",
      );
    });

    test("should preserve encrypted markers on unrelated function tools", () => {
      const tools = [
        {
          type: "function",
          name: "store_secret",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string", encrypted: true },
            },
          },
        },
      ];

      const { tools: result, toolMap } = convertResponsesToolsToVSCode(
        tools as any,
      );
      const inputSchema = result[0].inputSchema as any;

      assert.strictEqual(inputSchema.properties.message.encrypted, true);
      assert.strictEqual(
        toolMap.get("store_secret")?.plaintextArguments,
        undefined,
      );
    });

    test("should keep the first duplicate tool definition", () => {
      const tools = [
        {
          type: "function" as const,
          name: "wait",
          description: "Original definition",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function" as const,
          name: "wait",
          description: "Duplicate definition",
          parameters: {
            type: "object",
            properties: { ms: { type: "number" } },
          },
        },
      ];
      const { tools: result, toolMap } = convertResponsesToolsToVSCode(
        tools as any,
      );
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].description, "Original definition");
      assert.deepStrictEqual(toolMap.get("wait"), {
        name: "wait",
        isCustom: false,
      });
    });

    test("should skip non-function tools", () => {
      const tools = [
        { type: "function" as const, name: "valid_function" },
        { type: "file_search" as const, vector_store_ids: ["vs_123"] },
        { type: "web_search_preview" as const },
      ] as any[];
      const { tools: result } = convertResponsesToolsToVSCode(tools);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "valid_function");
    });

    test("should handle undefined tools", () => {
      const { tools: result } = convertResponsesToolsToVSCode(undefined);
      assert.strictEqual(result.length, 0);
    });

    test("should handle empty tools array", () => {
      const { tools: result } = convertResponsesToolsToVSCode([]);
      assert.strictEqual(result.length, 0);
    });

    test("should skip null/undefined items in tools array", () => {
      const tools = [
        null,
        { type: "function" as const, name: "valid" },
        undefined,
      ];
      const { tools: result } = convertResponsesToolsToVSCode(tools as any);
      assert.strictEqual(result.length, 1);
    });
  });

  suite("narrowToolsForChoice", () => {
    const vsTools = [
      { name: "exec", description: "", inputSchema: undefined },
      { name: "wait", description: "", inputSchema: undefined },
      {
        name: "collaboration__spawn_agent",
        description: "",
        inputSchema: undefined,
      },
    ];
    const toolMap = new Map<string, any>([
      ["exec", { name: "exec", isCustom: true }],
      ["wait", { name: "wait", isCustom: false }],
      [
        "collaboration__spawn_agent",
        { namespace: "collaboration", name: "spawn_agent", isCustom: false },
      ],
    ]);

    test("should narrow to the single named tool", () => {
      const result = narrowToolsForChoice(
        { type: "custom", name: "exec" } as any,
        vsTools,
        toolMap,
      );
      assert.strictEqual(result.ok, true);
      assert.ok(result.ok && result.tools.length === 1);
      assert.strictEqual(result.ok && result.tools[0].name, "exec");
    });

    test("should narrow to a namespaced tool by its bare name", () => {
      const result = narrowToolsForChoice(
        { type: "function", name: "spawn_agent" } as any,
        vsTools,
        toolMap,
      );
      assert.ok(result.ok && result.tools.length === 1);
      assert.strictEqual(
        result.ok && result.tools[0].name,
        "collaboration__spawn_agent",
      );
    });

    test("should fail when the named tool matches nothing", () => {
      const result = narrowToolsForChoice(
        { type: "function", name: "missing" } as any,
        vsTools,
        toolMap,
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(!result.ok && result.matchCount, 0);
      assert.strictEqual(!result.ok && result.targetName, "missing");
    });

    test("should fail when the chosen type disagrees with the tool kind", () => {
      // `exec` is a custom tool; asking for it as `function` must not match.
      const result = narrowToolsForChoice(
        { type: "function", name: "exec" } as any,
        vsTools,
        toolMap,
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(!result.ok && result.matchCount, 0);
    });

    test("should match a custom tool only for a custom choice", () => {
      const result = narrowToolsForChoice(
        { type: "custom", name: "exec" } as any,
        vsTools,
        toolMap,
      );
      assert.ok(result.ok && result.tools.length === 1);
      assert.strictEqual(result.ok && result.tools[0].name, "exec");
    });

    test("should keep all tools for non-named choices", () => {
      const req = narrowToolsForChoice("required" as any, vsTools, toolMap);
      assert.ok(req.ok && req.tools.length === 3);
      const none = narrowToolsForChoice(undefined, vsTools, toolMap);
      assert.ok(none.ok && none.tools.length === 3);
    });
  });

  suite("convertToolChoice", () => {
    test("should return undefined for none", () => {
      const result = convertToolChoice("none");
      assert.strictEqual(result, undefined);
    });

    test("should return undefined for null", () => {
      const result = convertToolChoice(null as any);
      assert.strictEqual(result, undefined);
    });

    test("should return undefined for undefined", () => {
      const result = convertToolChoice(undefined);
      assert.strictEqual(result, undefined);
    });

    test("should return Required for required", () => {
      const result = convertToolChoice("required");
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Required);
    });

    test("should return Required for function type object", () => {
      const result = convertToolChoice({
        type: "function" as const,
        name: "get_weather",
      });
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Required);
    });

    test("should return Required for custom type object", () => {
      const result = convertToolChoice({
        type: "custom" as const,
        name: "exec",
      } as any);
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Required);
    });

    test("should return Auto for auto", () => {
      const result = convertToolChoice("auto");
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Auto);
    });
  });

  suite("buildResponseOutput", () => {
    test("should build output with text only", () => {
      const output = buildResponseOutput("Hello world", []);
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0].type, "message");
      const msg = output[0] as any;
      assert.strictEqual(msg.role, "assistant");
      assert.strictEqual(msg.content[0].text, "Hello world");
      assert.strictEqual(msg.status, "completed");
    });

    test("should build output with tool calls only", () => {
      const toolCalls = [
        { callId: "call_1", name: "get_weather", input: { city: "NYC" } },
      ];
      const output = buildResponseOutput("", toolCalls);
      assert.strictEqual(output.length, 1);
      assert.strictEqual(output[0].type, "function_call");
      const fc = output[0] as any;
      assert.strictEqual(fc.name, "get_weather");
      assert.strictEqual(fc.call_id, "call_1");
      assert.strictEqual(fc.status, "completed");
    });

    test("should build output with text and tool calls", () => {
      const toolCalls = [
        { callId: "call_1", name: "func1", input: {} },
        { callId: "call_2", name: "func2", input: { a: 1 } },
      ];
      const output = buildResponseOutput("Some text", toolCalls);
      assert.strictEqual(output.length, 3);
      assert.strictEqual(output[0].type, "message");
      assert.strictEqual(output[1].type, "function_call");
      assert.strictEqual(output[2].type, "function_call");
    });

    test("should handle empty text and no tool calls", () => {
      const output = buildResponseOutput("", []);
      assert.strictEqual(output.length, 0);
    });

    test("should handle null/undefined input in tool call", () => {
      const toolCalls = [{ callId: "call_1", name: "func", input: null }];
      const output = buildResponseOutput("", toolCalls as any);
      assert.strictEqual(output.length, 1);
      const fc = output[0] as any;
      assert.strictEqual(fc.arguments, "{}");
    });

    test("should emit custom_tool_call for custom tools via toolMap", () => {
      const toolCalls = [
        { callId: "call_1", name: "get_weather", input: { city: "NYC" } },
        { callId: "call_2", name: "exec", input: { input: "pwd" } },
      ];
      const toolMap = new Map([
        ["get_weather", { name: "get_weather", isCustom: false }],
        ["exec", { name: "exec", isCustom: true }],
      ]);
      const output = buildResponseOutput("", toolCalls, toolMap as any);
      assert.strictEqual(output.length, 2);
      assert.strictEqual(output[0].type, "function_call");
      assert.strictEqual(output[1].type, "custom_tool_call");
      const ctc = output[1] as any;
      assert.strictEqual(ctc.name, "exec");
      assert.strictEqual(ctc.call_id, "call_2");
      // Wrapped raw-string input is unwrapped back to the raw string.
      assert.strictEqual(ctc.input, "pwd");
    });

    test("should decode namespaced names and restore namespace field", () => {
      const toolCalls = [
        {
          callId: "call_1",
          name: "collaboration__spawn_agent",
          input: { task: "x" },
        },
        {
          callId: "call_2",
          name: "collaboration__raw_helper",
          input: { source: "raw" },
        },
      ];
      const toolMap = new Map([
        [
          "collaboration__spawn_agent",
          {
            namespace: "collaboration",
            name: "spawn_agent",
            isCustom: false,
            plaintextArguments: true,
          },
        ],
        [
          "collaboration__raw_helper",
          { namespace: "collaboration", name: "raw_helper", isCustom: true },
        ],
      ]);
      const output = buildResponseOutput("", toolCalls, toolMap as any);
      const fc = output[0] as any;
      assert.strictEqual(fc.type, "function_call");
      assert.strictEqual(fc.name, "spawn_agent");
      assert.strictEqual(fc.namespace, "collaboration");
      assert.deepStrictEqual(fc.encrypted_function_args, []);
      const ctc = output[1] as any;
      assert.strictEqual(ctc.type, "custom_tool_call");
      assert.strictEqual(ctc.name, "raw_helper");
      assert.strictEqual(ctc.namespace, "collaboration");
      assert.strictEqual(ctc.input, "raw");
    });
  });

  suite("extractAdditionalTools", () => {
    test("should extract tools from additional_tools items", () => {
      const input = [
        { role: "user" as const, content: "hi" },
        {
          type: "additional_tools" as const,
          role: "developer" as const,
          tools: [
            { type: "custom" as const, name: "exec" },
            { type: "function" as const, name: "wait" },
          ],
        },
      ];
      const tools = extractAdditionalTools(input as any);
      assert.strictEqual(tools.length, 2);
      assert.deepStrictEqual(
        tools.map((t: any) => t.name),
        ["exec", "wait"],
      );
    });

    test("should return empty array for string input", () => {
      assert.strictEqual(extractAdditionalTools("hello").length, 0);
    });

    test("should return empty array when no additional_tools present", () => {
      const input = [{ role: "user" as const, content: "hi" }];
      assert.strictEqual(extractAdditionalTools(input as any).length, 0);
    });
  });

  suite("customToolCallInput", () => {
    test("should pass through a raw string", () => {
      assert.strictEqual(customToolCallInput("pwd"), "pwd");
    });

    test("should unwrap the { input } wrapper", () => {
      assert.strictEqual(customToolCallInput({ input: "ls -la" }), "ls -la");
    });

    test("should unwrap the { source } wrapper", () => {
      const source =
        'const r = await tools.exec_command({cmd: "git status --short"}); text(r.output);';
      assert.strictEqual(customToolCallInput({ source }), source);
    });

    test("should JSON-stringify other object shapes", () => {
      assert.strictEqual(customToolCallInput({ a: 1 }), '{"a":1}');
    });

    test("should stringify null/undefined to empty string", () => {
      assert.strictEqual(customToolCallInput(null), "");
      assert.strictEqual(customToolCallInput(undefined), "");
    });
  });

  suite("extractOpenAIResponsesUsage", () => {
    test("should map Copilot usage metadata to OpenAI responses usage", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 10445,
          completion_tokens: 88,
          total_tokens: 10533,
          prompt_tokens_details: { cached_tokens: 25 },
          completion_tokens_details: { reasoning_tokens: 80 },
        }),
      });

      assert.deepStrictEqual(result, {
        input_tokens: 10445,
        input_tokens_details: { cached_tokens: 25, cache_write_tokens: 0 },
        output_tokens: 88,
        output_tokens_details: { reasoning_tokens: 80 },
        total_tokens: 10533,
      });
    });

    test("should fall back to prompt plus completion when total is missing", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 100,
          completion_tokens: 20,
        }),
      });

      assert.strictEqual(result?.total_tokens, 120);
    });

    test("should fall back to prompt plus completion when total is invalid", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: -1,
        }),
      });

      assert.strictEqual(result?.total_tokens, 120);
    });

    test("should keep zero total tokens when provided", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 0,
        }),
      });

      assert.strictEqual(result?.total_tokens, 0);
    });

    test("should return undefined for malformed JSON", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: new TextEncoder().encode("not json {"),
      });

      assert.strictEqual(result, undefined);
    });

    test("should return undefined when prompt_tokens is missing", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: encode({ completion_tokens: 1 }),
      });

      assert.strictEqual(result, undefined);
    });

    test("should return undefined when completion_tokens is negative", () => {
      const result = extractOpenAIResponsesUsage({
        mimeType: "usage",
        data: encode({ prompt_tokens: 1, completion_tokens: -1 }),
      });

      assert.strictEqual(result, undefined);
    });
  });
});
