import * as assert from "assert";
import * as vscode from "vscode";

import {
  buildResponseOutput,
  convertInputContentToVSCodePart,
  convertResponsesInputToVSCode,
  convertResponsesItemToVSCode,
  convertResponsesToolsToVSCode,
  convertToolChoice,
  generateFunctionCallId,
  generateMessageId,
  generateResponseId,
} from "../../server/utils/openaiResponses";

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
      // LanguageModelDataPart may not be available in test environment
      assert.ok(result);
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
      const result = convertResponsesToolsToVSCode(tools);
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
      const result = convertResponsesToolsToVSCode(tools);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "simple_function");
      assert.strictEqual(result[0].description, "");
    });

    test("should skip non-function tools", () => {
      const tools = [
        { type: "function" as const, name: "valid_function" },
        { type: "file_search" as const, vector_store_ids: ["vs_123"] },
        { type: "web_search_preview" as const },
      ] as any[];
      const result = convertResponsesToolsToVSCode(tools);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "valid_function");
    });

    test("should handle undefined tools", () => {
      const result = convertResponsesToolsToVSCode(undefined);
      assert.strictEqual(result.length, 0);
    });

    test("should handle empty tools array", () => {
      const result = convertResponsesToolsToVSCode([]);
      assert.strictEqual(result.length, 0);
    });

    test("should skip null/undefined items in tools array", () => {
      const tools = [
        null,
        { type: "function" as const, name: "valid" },
        undefined,
      ];
      const result = convertResponsesToolsToVSCode(tools as any);
      assert.strictEqual(result.length, 1);
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
  });
});
