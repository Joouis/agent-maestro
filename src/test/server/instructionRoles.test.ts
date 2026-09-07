import * as assert from "assert";
import * as vscode from "vscode";

import { convertOpenAIMessagesToVSCode } from "../../server/utils/openaiChat";
import { convertResponsesInputToVSCode } from "../../server/utils/openaiResponses";

suite("OpenAI instruction role preservation", () => {
  const roles = vscode.LanguageModelChatMessageRole;

  for (const role of ["system", "developer"] as const) {
    test(`preserves Responses ${role} arrays through normalization`, () => {
      const messages = convertResponsesInputToVSCode([
        {
          type: "message",
          role,
          content: [{ type: "input_text", text: "Explain progress" }],
        },
        { role: "user", content: "Check build" },
      ]);
      assert.deepStrictEqual(
        messages.map((message) => message.role),
        [roles.System, roles.User],
      );
      assert.strictEqual(
        (messages[0].content[0] as vscode.LanguageModelTextPart).value,
        "Explain progress",
      );
    });

    test(`preserves Chat ${role} arrays through normalization`, () => {
      const messages = convertOpenAIMessagesToVSCode([
        { role, content: [{ type: "text", text: "Explain progress" }] },
        { role: "user", content: "Check build" },
      ]);
      assert.deepStrictEqual(
        messages.map((message) => message.role),
        [roles.System, roles.User],
      );
    });
  }

  test("preserves string instructions without promoting input or breaking tool pairs", () => {
    const messages = convertResponsesInputToVSCode(
      [
        { role: "user", content: "Check build" },
        { role: "assistant", content: "Checking" },
        {
          type: "function_call",
          call_id: "build",
          name: "get_status",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "build", output: "passed" },
      ],
      "Explain progress",
    );
    assert.deepStrictEqual(
      messages.map((message) => message.role),
      [roles.System, roles.User, roles.Assistant, roles.Assistant, roles.User],
    );
    assert.ok(
      messages[3].content[0] instanceof vscode.LanguageModelToolCallPart,
    );
    assert.ok(
      messages[4].content[0] instanceof vscode.LanguageModelToolResultPart,
    );
  });

  test("keeps instruction boundaries from pairing unrelated tool history", () => {
    const messages = convertResponsesInputToVSCode([
      {
        type: "function_call",
        call_id: "build",
        name: "get_status",
        arguments: "{}",
      },
      { role: "developer", content: "New instructions" },
      { type: "function_call_output", call_id: "build", output: "passed" },
    ]);
    assert.deepStrictEqual(
      messages.map((message) => message.role),
      [roles.Assistant, roles.System, roles.User],
    );
    assert.ok(
      messages.every((message) =>
        message.content.every(
          (part) => part instanceof vscode.LanguageModelTextPart,
        ),
      ),
    );
  });

  test("respects individual roles in legacy instruction arrays", () => {
    const messages = convertResponsesInputToVSCode("request", [
      { role: "developer", content: "instructions" },
      { role: "user", content: "context" },
    ]);
    assert.deepStrictEqual(
      messages.map((message) => message.role),
      [roles.System, roles.User, roles.User],
    );
  });
});
