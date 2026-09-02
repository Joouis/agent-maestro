import * as assert from "assert";
import * as vscode from "vscode";

import { extractOpenAIResponsesUsage } from "../../server/utils/openai";
import {
  buildResponseOutput,
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
} from "../../server/utils/openaiResponses";
import { logger } from "../../utils/logger";

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

suite("OpenAI Responses Conversion Utils Test Suite", () => {
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
            output: "duplicate output",
          },
          {
            type: "function_call_output",
            call_id: "call_missing",
            output: "duplicate orphaned output",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_custom",
            output: "custom output",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_custom",
            output: "duplicate custom output",
          },
        ] as any);

        assert.strictEqual(result.length, 3);
        assert.deepStrictEqual(
          toolCallParts(result[0]).map((part) => part.callId),
          ["call_known", "call_custom"],
        );
        const orphanedParts = result[1].content;
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
        assert.match(warnings[0], /converted 1 orphaned result/);
        assert.match(warnings[0], /dropped 3 duplicate result/);
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
        assert.match(
          warnings[0],
          /converted 2 call\(s\) and 2 result\(s\) with invalid IDs/,
        );
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

    test("should convert custom tool to a schema-less tool", () => {
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
      assert.strictEqual(result[0].inputSchema, undefined);
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
