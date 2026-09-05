import * as assert from "assert";
import * as vscode from "vscode";

import { convertAnthropicMessagesToVSCode } from "../../server/utils/anthropic";
import { convertGeminiContentsToVSCode } from "../../server/utils/gemini";
import { convertOpenAIMessagesToVSCode } from "../../server/utils/openaiChat";
import { convertResponsesInputToVSCode } from "../../server/utils/openaiResponses";
import {
  type ToolHistoryMessage,
  type ToolHistoryPart,
  normalizeToolHistory,
  toolHistoryToVSCode,
} from "../../server/utils/toolResultPairing";
import { logger } from "../../utils/logger";

type Call = { kind: "call"; id?: string; name?: string; args?: object };
type Result = { kind: "result"; id?: string; name?: string; value?: unknown };
type Text = { kind: "text"; text: string };
type Message = {
  role: "user" | "assistant";
  parts: Array<Call | Result | Text>;
};
const C = (id?: string, name = "lookup", args: object = {}): Call => ({
  kind: "call",
  id,
  name,
  args,
});
const R = (id?: string, value: unknown = "ok", name = "lookup"): Result => ({
  kind: "result",
  id,
  name,
  value,
});
const M = (...parts: Array<Call | Text>): Message => ({
  role: "assistant",
  parts,
});
const U = (...parts: Array<Result | Text>): Message => ({
  role: "user",
  parts,
});
const T = (text: string): Text => ({ kind: "text", text });
const encode = (value: unknown): string => JSON.stringify(value);
const adapters = {
  Anthropic: (messages: Message[]) =>
    convertAnthropicMessagesToVSCode(
      messages.map((m) => ({
        role: m.role,
        content: m.parts.map((p) => {
          if (p.kind === "text") {
            return { type: "text", text: p.text };
          }
          if (p.kind === "call") {
            return { type: "tool_use", id: p.id, name: p.name, input: p.args };
          }
          return {
            type: "tool_result",
            tool_use_id: p.id,
            content: encode(p.value),
          };
        }),
      })) as any,
    ),
  Chat: (messages: Message[]) =>
    convertOpenAIMessagesToVSCode(
      messages.flatMap((m) =>
        m.role === "assistant"
          ? [
              {
                role: "assistant",
                content: m.parts
                  .filter((p): p is Text => p.kind === "text")
                  .map((p) => p.text)
                  .join(""),
                tool_calls: m.parts
                  .filter((p): p is Call => p.kind === "call")
                  .map((p) => ({
                    id: p.id,
                    type: "function",
                    function: { name: p.name, arguments: encode(p.args) },
                  })),
              },
            ]
          : m.parts.map((p) =>
              p.kind === "result"
                ? { role: "tool", tool_call_id: p.id, content: encode(p.value) }
                : { role: "user", content: (p as Text).text },
            ),
      ) as any,
    ),
  Responses: (messages: Message[]) =>
    convertResponsesInputToVSCode(
      messages.flatMap((m) =>
        m.parts.map((p) => {
          if (p.kind === "text") {
            return { role: m.role, content: p.text };
          }
          if (p.kind === "call") {
            return {
              type: "function_call",
              call_id: p.id,
              name: p.name,
              arguments: encode(p.args),
            };
          }
          return {
            type: "function_call_output",
            call_id: p.id,
            output: encode(p.value),
          };
        }),
      ) as any,
    ),
  Gemini: (messages: Message[]) =>
    convertGeminiContentsToVSCode(
      messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: m.parts.map((p) => {
          if (p.kind === "text") {
            return { text: p.text };
          }
          if (p.kind === "call") {
            return { functionCall: { id: p.id, name: p.name, args: p.args } };
          }
          return {
            functionResponse: {
              id: p.id,
              name: p.name,
              response: { output: p.value },
            },
          };
        }),
      })) as any,
    ),
};
const calls = (messages: vscode.LanguageModelChatMessage[]) =>
  messages
    .flatMap((m) => m.content)
    .filter(
      (p): p is vscode.LanguageModelToolCallPart =>
        p instanceof vscode.LanguageModelToolCallPart,
    );
const results = (messages: vscode.LanguageModelChatMessage[]) =>
  messages
    .flatMap((m) => m.content)
    .filter(
      (p): p is vscode.LanguageModelToolResultPart =>
        p instanceof vscode.LanguageModelToolResultPart,
    );
const text = (messages: vscode.LanguageModelChatMessage[]) =>
  messages
    .flatMap((m) => m.content)
    .filter(
      (p): p is vscode.LanguageModelTextPart =>
        p instanceof vscode.LanguageModelTextPart,
    )
    .map((p) => p.value)
    .join("\n");
function paired(messages: vscode.LanguageModelChatMessage[], count: number) {
  assert.strictEqual(calls(messages).length, count);
  assert.strictEqual(results(messages).length, count);
  assert.strictEqual(new Set(calls(messages).map((c) => c.callId)).size, count);
  assert.deepStrictEqual(
    results(messages)
      .map((r) => r.callId)
      .sort(),
    calls(messages)
      .map((c) => c.callId)
      .sort(),
  );
  const pending = new Set<string>();
  for (const message of messages) {
    for (const p of message.content) {
      if (p instanceof vscode.LanguageModelToolCallPart) {
        pending.add(p.callId);
      }
      if (p instanceof vscode.LanguageModelToolResultPart) {
        assert.ok(pending.delete(p.callId));
      }
    }
  }
  assert.strictEqual(pending.size, 0);
}

suite("Unified tool history", () => {
  for (const [name, convert] of Object.entries(adapters)) {
    suite(name, () => {
      test("preserves a valid pair and source input", () => {
        const input = [M(C("x")), U(R("x"))];
        const original = structuredClone(input);
        const actual = convert(input);
        paired(actual, 1);
        assert.strictEqual(calls(actual)[0].callId, "x");
        assert.deepStrictEqual(input, original);
        assert.deepStrictEqual(convert(input), actual);
      });
      test("keeps missing execution status without call arguments", () => {
        const actual = convert([
          M(C("x", "submit", { secret: "not-in-note" }), C("y", "read", {})),
          U(T("continue")),
        ]);
        paired(actual, 0);
        assert.match(text(actual), /Execution status is unknown/);
        assert.ok(!text(actual).includes("not-in-note"));
        assert.ok(text(actual).includes("continue"));
      });
      test("preserves orphaned result content without poisoning a later pair", () => {
        const actual = convert([
          U(R("x", "earlier")),
          M(C("x")),
          U(R("x", "later")),
        ]);
        paired(actual, 1);
        assert.match(text(actual), /without a matching tool call/);
        assert.ok(text(actual).includes("earlier"));
        assert.ok(
          (
            results(actual)[0].content[0] as vscode.LanguageModelTextPart
          ).value.includes("later"),
        );
      });
      test("merges identical calls and results within one turn", () => {
        const actual = convert([M(C("x"), C("x")), U(R("x"), R("x"))]);
        paired(actual, 1);
      });
      test("keeps orphan context and parallel results in one emitted result turn", () => {
        const actual = convert([
          M(C("a"), C("b")),
          U(R("a")),
          U(R("unknown", "saved")),
          U(R("b")),
        ]);
        paired(actual, 2);
        const resultMessages = actual.filter((m) =>
          m.content.some(
            (p) => p instanceof vscode.LanguageModelToolResultPart,
          ),
        );
        assert.strictEqual(resultMessages.length, 1);
        assert.ok(
          resultMessages[0].content[0] instanceof
            vscode.LanguageModelToolResultPart,
        );
        assert.ok(
          resultMessages[0].content[1] instanceof
            vscode.LanguageModelToolResultPart,
        );
        assert.ok(
          resultMessages[0].content.some(
            (p) =>
              p instanceof vscode.LanguageModelTextPart &&
              p.value.includes("saved"),
          ),
        );
      });
      test("preserves two complete replayed pairs across turns", () => {
        const actual = convert([
          M(C("x")),
          U(R("x")),
          M(C("x")),
          U(R("x", "new")),
        ]);
        paired(actual, 2);
        assert.notStrictEqual(calls(actual)[0].callId, calls(actual)[1].callId);
      });
      test("preserves conflicting results without choosing a winner", () => {
        const actual = convert([
          M(C("x")),
          U(R("x", "first"), R("x", "second")),
        ]);
        paired(actual, 0);
        assert.match(text(actual), /Conflicting tool history/);
        assert.ok(
          text(actual).includes("first") && text(actual).includes("second"),
        );
      });
      test("does not emit ambiguous same-ID calls", () => {
        const actual = convert([
          M(C("x", "first", { a: 1 }), C("x", "second", { a: 2 })),
          U(R("x")),
        ]);
        paired(actual, 0);
        assert.match(text(actual), /Conflicting tool history/);
      });
      test("pairs parallel out-of-order results and handles a missing sibling", () => {
        const actual = convert([
          M(C("a"), C("b"), C("missing")),
          U(R("b")),
          U(R("a")),
        ]);
        paired(actual, 2);
        assert.deepStrictEqual(
          results(actual).map((r) => r.callId),
          ["b", "a"],
        );
        assert.match(text(actual), /Execution status is unknown/);
      });
      test("does not match through independent user input or assistant text", () => {
        for (const boundary of [U(T("new instruction")), M(T("explanation"))]) {
          const actual = convert([M(C("x")), boundary, U(R("x"))]);
          paired(actual, 0);
          assert.match(text(actual), /Execution status is unknown/);
          assert.match(text(actual), /without a matching tool call/);
        }
      });
      test("retains empty, false, zero and large orphan results", () => {
        for (const value of ["", false, 0, {}, "z".repeat(20_000)]) {
          const actual = convert([U(R("x", value))]);
          paired(actual, 0);
          assert.ok(text(actual).includes(encode(value)));
        }
      });
      test("keeps an explicitly empty result as a completed pair", () => {
        paired(convert([M(C("x")), U(R("x", ""))]), 1);
      });
    });
  }

  test("Gemini reserves explicit matches before id-less FIFO", () => {
    const actual = adapters.Gemini([
      M(C("a"), C("b")),
      U(R(undefined, "B"), R("a", "A")),
    ]);
    paired(actual, 2);
    assert.deepStrictEqual(
      results(actual).map((r) => r.callId),
      ["b", "a"],
    );
  });
  test("Gemini never consumes a future id-less call", () => {
    const actual = adapters.Gemini([
      M(C()),
      U(R(undefined), R(undefined, "excess")),
      M(C()),
      U(R(undefined, "next")),
    ]);
    paired(actual, 2);
    assert.ok(text(actual).includes("excess"));
  });
  test("Gemini partial id-less parallel turn keeps one pair", () => {
    const actual = adapters.Gemini([M(C(), C()), U(R(undefined))]);
    paired(actual, 1);
    assert.match(text(actual), /Execution status is unknown/);
  });
  test("Gemini distinguishes structurally different values from key order", () => {
    paired(
      adapters.Gemini([
        M(C("x")),
        U(R("x", { a: 1, b: 2 }), R("x", { b: 2, a: 1 })),
      ]),
      1,
    );
  });
  test("Responses keeps function and custom namespaces distinct", () => {
    const actual = convertResponsesInputToVSCode([
      { type: "function_call", call_id: "x", name: "f", arguments: "{}" },
      { type: "custom_tool_call", call_id: "x", name: "f", input: "raw" },
      { type: "custom_tool_call_output", call_id: "x", output: "custom" },
      { type: "function_call_output", call_id: "x", output: "function" },
    ] as any);
    paired(actual, 2);
  });
  test("Chat retains free-form custom input instead of parsing it as JSON", () => {
    const actual = convertOpenAIMessagesToVSCode([
      {
        role: "assistant",
        tool_calls: [
          {
            type: "custom",
            id: "x",
            custom: { name: "shell", input: "echo hello" },
          },
        ],
      },
      { role: "tool", tool_call_id: "x", content: "hello" },
    ]);
    paired(actual, 1);
    assert.deepStrictEqual(calls(actual)[0].input, { input: "echo hello" });
  });
  test("Chat pairs supported calls after skipping unknown tool types", () => {
    const input = [
      {
        role: "assistant",
        content: "Working",
        tool_calls: [
          { type: "future_tool", id: "unknown-before" },
          {
            type: "function",
            id: "lookup-id",
            function: { name: "lookup", arguments: '{"key":"value"}' },
          },
          { type: "future_tool", id: "unknown-between" },
          {
            type: "custom",
            id: "shell-id",
            custom: { name: "shell", input: "echo hello" },
          },
        ],
      },
      { role: "tool", tool_call_id: "shell-id", content: "hello" },
      { role: "tool", tool_call_id: "lookup-id", content: "found" },
    ];
    const original = structuredClone(input);
    const actual = convertOpenAIMessagesToVSCode(input as any);
    paired(actual, 2);
    assert.deepStrictEqual(
      calls(actual).map((call) => [call.callId, call.name, call.input]),
      [
        ["lookup-id", "lookup", { key: "value" }],
        ["shell-id", "shell", { input: "echo hello" }],
      ],
    );
    assert.deepStrictEqual(
      results(actual).map((result) => [
        result.callId,
        (result.content[0] as vscode.LanguageModelTextPart).value,
      ]),
      [
        ["shell-id", "hello"],
        ["lookup-id", "found"],
      ],
    );
    assert.ok(text(actual).includes("Working"));
    assert.deepStrictEqual(input, original);
  });
  test("Anthropic wrong-role calls retain context without consuming later results", () => {
    const actual = convertAnthropicMessagesToVSCode([
      {
        role: "user",
        content: [
          {
            type: "tool_use",
            id: "x",
            name: "submit",
            input: { secret: "omitted-arguments" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }],
      },
    ]);
    paired(actual, 1);
    assert.strictEqual(
      actual[0].role,
      vscode.LanguageModelChatMessageRole.User,
    );
    assert.match(text([actual[0]]), /tool call.*user message/i);
    assert.match(text([actual[0]]), /submit/);
    assert.match(text([actual[0]]), /x/);
    assert.match(text([actual[0]]), /Execution status is unknown/);
    assert.ok(!text(actual).includes("omitted-arguments"));
    assert.strictEqual(calls(actual)[0].name, "read");
  });
  test("Anthropic wrong-role results preserve text, errors, media and source order", () => {
    const bytes = Buffer.from([1, 2, 3]);
    const input = [
      {
        role: "assistant" as const,
        content: [
          { type: "text" as const, text: "before" },
          {
            type: "tool_result" as const,
            tool_use_id: "saved-result",
            is_error: true,
            content: [
              { type: "text" as const, text: "saved body" },
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/png" as const,
                  data: bytes.toString("base64"),
                },
              },
            ],
          },
          { type: "text" as const, text: "after" },
        ],
      },
    ];
    const original = structuredClone(input);
    const actual = convertAnthropicMessagesToVSCode(input);
    paired(actual, 0);
    assert.strictEqual(actual.length, 1);
    assert.strictEqual(
      actual[0].role,
      vscode.LanguageModelChatMessageRole.Assistant,
    );
    const parts = actual[0].content;
    assert.strictEqual(
      (parts[0] as vscode.LanguageModelTextPart).value,
      "before",
    );
    assert.match(
      (parts[1] as vscode.LanguageModelTextPart).value,
      /tool result.*assistant message.*saved-result/i,
    );
    assert.match(
      (parts[2] as vscode.LanguageModelTextPart).value,
      /Tool reported an error/,
    );
    assert.strictEqual(
      (parts[3] as vscode.LanguageModelTextPart).value,
      "saved body",
    );
    assert.ok(parts[4] instanceof vscode.LanguageModelDataPart);
    assert.strictEqual(parts[4].mimeType, "image/png");
    assert.deepStrictEqual(Buffer.from(parts[4].data), bytes);
    assert.strictEqual(
      (parts[5] as vscode.LanguageModelTextPart).value,
      "after",
    );
    assert.deepStrictEqual(input, original);
  });
  test("Anthropic wrong-role empty results retain provenance without pairing", () => {
    const actual = convertAnthropicMessagesToVSCode([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "x", name: "read", input: {} },
          { type: "tool_result", tool_use_id: "x", content: "" },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: "actual" }],
      },
    ]);
    paired(actual, 1);
    assert.match(text(actual), /tool result.*assistant message/i);
    assert.strictEqual(
      (results(actual)[0].content[0] as vscode.LanguageModelTextPart).value,
      "actual",
    );
  });
  test("Anthropic error status survives when a result becomes context", () => {
    const actual = convertAnthropicMessagesToVSCode([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "missing",
            content: "",
            is_error: true,
          },
        ],
      },
    ]);
    paired(actual, 0);
    assert.match(text(actual), /Tool reported an error/);
  });
  test("resume-shaped history keeps differing masked/full bodies as conflict context", () => {
    const input: Message[] = [];
    for (let index = 0; index < 30; index++) {
      input.push(M(C("call_" + index)));
      input.push(
        U(
          R("call_" + index, "full " + index),
          R("call_" + index, index % 2 ? "full " + index : "masked " + index),
        ),
      );
    }
    const actual = adapters.Gemini(input);
    paired(actual, 15);
    for (let index = 0; index < 30; index += 2) {
      assert.ok(text(actual).includes("full " + index));
      assert.ok(text(actual).includes("masked " + index));
    }
  });
  test("request instructions cannot provide a result to input", () => {
    const actual = convertResponsesInputToVSCode(
      [{ type: "function_call_output", call_id: "x", output: "late" }],
      [{ type: "function_call", call_id: "x", name: "f", arguments: "{}" }],
    );
    paired(actual, 0);
  });
});

suite("Tool history normalizer", () => {
  const call = (id?: string): ToolHistoryPart => ({
    kind: "call",
    id,
    name: "f",
    input: {},
    value: {},
    toolType: "function",
    allowMissingId: true,
  });
  const result = (
    id?: string,
    value: unknown = { ok: true },
  ): ToolHistoryPart => ({
    kind: "result",
    id,
    name: "f",
    value,
    parts: [new vscode.LanguageModelTextPart(encode(value))],
    toolType: "function",
    allowMissingId: true,
  });
  const model = (...parts: ToolHistoryPart[]): ToolHistoryMessage => ({
    role: "assistant",
    parts,
  });
  const user = (...parts: ToolHistoryPart[]): ToolHistoryMessage => ({
    role: "user",
    parts,
  });
  test("reserves all explicit IDs before generating request-local IDs", () => {
    const actual = toolHistoryToVSCode(
      [
        model(call()),
        user(result()),
        model(call("am_history_0_0")),
        user(result("am_history_0_0")),
      ],
      "Test",
    );
    paired(actual, 2);
    assert.strictEqual(calls(actual)[1].callId, "am_history_0_0");
  });
  test("retains media when orphaned or conflicting", () => {
    const image = new vscode.LanguageModelDataPart(
      new Uint8Array([1, 2, 3]),
      "image/png",
    );
    const r = { ...result("x"), parts: [image] } as ToolHistoryPart;
    for (const input of [
      [user(r)],
      [model(call("x")), user(r, result("x", "other"))],
    ]) {
      const actual = toolHistoryToVSCode(input, "Test");
      paired(actual, 0);
      assert.ok(actual.flatMap((m) => m.content).includes(image));
    }
  });
  test("logs only counts, with no result bodies or IDs", () => {
    const warnings: string[] = [];
    const warn = logger.warn;
    logger.warn = (message: string) => warnings.push(message);
    try {
      const history = [
        model(call("sensitive-id")),
        user(
          result("sensitive-id", "secret"),
          result("sensitive-id", "conflict"),
        ),
      ];
      const { diagnostics } = normalizeToolHistory(history);
      assert.strictEqual(diagnostics.conflictGroups, 1);
      toolHistoryToVSCode(history, "Test");
      assert.strictEqual(warnings.length, 1);
      assert.ok(
        !warnings[0].includes("sensitive-id") &&
          !warnings[0].includes("secret"),
      );
    } finally {
      logger.warn = warn;
    }
  });
  test("idempotently retains normalized parts and unique IDs", () => {
    const initial = [
      model(call("x")),
      user(result("x")),
      model(call("x")),
      user(result("x")),
      model(call("missing")),
    ];
    const once = toolHistoryToVSCode(initial, "Test");
    const roundtrip: ToolHistoryMessage[] = once.map((m) => ({
      role:
        m.role === vscode.LanguageModelChatMessageRole.Assistant
          ? "assistant"
          : "user",
      parts: m.content.map((p): ToolHistoryPart => {
        if (p instanceof vscode.LanguageModelToolCallPart) {
          return {
            kind: "call",
            id: p.callId,
            name: p.name,
            input: p.input,
            value: p.input,
            toolType: "function",
          };
        }
        if (p instanceof vscode.LanguageModelToolResultPart) {
          return {
            kind: "result",
            id: p.callId,
            parts: p.content as any,
            value: p.content,
            toolType: "function",
          };
        }
        return { kind: "content", parts: [p] };
      }),
    }));
    assert.deepStrictEqual(toolHistoryToVSCode(roundtrip, "Test"), once);
  });
});
