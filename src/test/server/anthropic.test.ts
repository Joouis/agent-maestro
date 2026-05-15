import * as assert from "assert";
import * as vscode from "vscode";

import {
  convertAnthropicMessageToVSCode,
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
} from "../../server/utils/anthropic";
import { isResponseTooLongError } from "../../server/utils/languageModelErrors";

suite("Anthropic Conversion Utils Test Suite", () => {
  suite("convertAnthropicMessageToVSCode", () => {
    test("should convert user message with string content", () => {
      const message = {
        role: "user" as const,
        content: "Hello, how are you?",
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });

    test("should convert assistant message with string content", () => {
      const message = {
        role: "assistant" as const,
        content: "I am doing well, thank you!",
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should convert user message with text block array", () => {
      const message = {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "First part" },
          { type: "text" as const, text: "Second part" },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });

    test("should ignore cache_control metadata on text blocks", () => {
      const message = {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "Stable cached context",
            cache_control: { type: "ephemeral" },
          },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message as any);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
      assert.strictEqual(result.content.length, 1);
      assert.ok(result.content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        (result.content[0] as vscode.LanguageModelTextPart).value,
        "Stable cached context",
      );
    });

    test("should convert assistant message with tool use", () => {
      const message = {
        role: "assistant" as const,
        content: [
          {
            type: "tool_use" as const,
            id: "tool-123",
            name: "get_weather",
            input: { city: "New York" },
          },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should convert user message with tool result", () => {
      const message = {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "tool-123",
            content: "The weather is sunny",
          },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });

    test("should convert tool_result with image content block", () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const message = {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "tool-456",
            content: [
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/png" as const,
                  data: base64Data,
                },
              },
            ],
          },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
      assert.strictEqual(result.content.length, 1);
      const toolResultPart = result
        .content[0] as vscode.LanguageModelToolResultPart;
      assert.ok(toolResultPart instanceof vscode.LanguageModelToolResultPart);
      assert.strictEqual(toolResultPart.callId, "tool-456");
      assert.strictEqual(toolResultPart.content.length, 1);
      // LanguageModelDataPart may not be available in the test environment,
      // so the image part could be either a DataPart or a TextPart fallback.
      // The key regression check is that it is NOT a JSON-stringified blob:
      // before this fix, the image block was serialized via JSON.stringify(c)
      // and the resulting TextPart's value started with `{"type":"image"`.
      const imagePart = toolResultPart.content[0];
      assert.ok(imagePart);
      if (imagePart instanceof vscode.LanguageModelTextPart) {
        assert.ok(
          !imagePart.value.startsWith('{"type":"image"'),
          "image block should not be delivered as a JSON-stringified text blob",
        );
      }
    });

    test("should convert tool_result with mixed text and image content", () => {
      const base64Data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const message = {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: "tool-789",
            content: [
              { type: "text" as const, text: "Here is the screenshot:" },
              {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: "image/png" as const,
                  data: base64Data,
                },
              },
            ],
          },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      const toolResultPart = result
        .content[0] as vscode.LanguageModelToolResultPart;
      assert.strictEqual(toolResultPart.content.length, 2);
      assert.ok(
        toolResultPart.content[0] instanceof vscode.LanguageModelTextPart,
      );
      assert.strictEqual(
        (toolResultPart.content[0] as vscode.LanguageModelTextPart).value,
        "Here is the screenshot:",
      );
      const imagePart = toolResultPart.content[1];
      assert.ok(imagePart);
      if (imagePart instanceof vscode.LanguageModelTextPart) {
        assert.ok(
          !imagePart.value.startsWith('{"type":"image"'),
          "image block should not be delivered as a JSON-stringified text blob",
        );
      }
    });

    test("should handle thinking block", () => {
      const message = {
        role: "assistant" as const,
        content: [
          {
            type: "thinking" as const,
            thinking: "Let me think about this...",
            signature: "thinking_signature_abc123",
          },
          { type: "text" as const, text: "Here is my answer" },
        ],
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });
  });

  suite("convertAnthropicMessagesToVSCode", () => {
    test("should convert array of messages", () => {
      const messages = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there!" },
        { role: "user" as const, content: "How are you?" },
      ];

      const result = convertAnthropicMessagesToVSCode(messages);

      assert.strictEqual(result.length, 3);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
      assert.strictEqual(
        result[1].role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
      assert.strictEqual(
        result[2].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should handle empty messages array", () => {
      const result = convertAnthropicMessagesToVSCode([]);
      assert.strictEqual(result.length, 0);
    });
  });

  suite("convertAnthropicSystemToVSCode", () => {
    test("should convert string system prompt", () => {
      const result = convertAnthropicSystemToVSCode(
        "You are a helpful assistant",
      );

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert array of text blocks", () => {
      const system = [
        { type: "text" as const, text: "You are a helpful assistant" },
        { type: "text" as const, text: "Be concise" },
      ];

      const result = convertAnthropicSystemToVSCode(system);

      assert.strictEqual(result.length, 2);
    });

    test("should ignore cache_control metadata on system text blocks", () => {
      const system = [
        {
          type: "text" as const,
          text: "Reusable system prompt",
          cache_control: { type: "ephemeral" },
        },
      ];

      const result = convertAnthropicSystemToVSCode(system as any);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
      assert.strictEqual(result[0].content.length, 1);
      assert.ok(result[0].content[0] instanceof vscode.LanguageModelTextPart);
      assert.strictEqual(
        (result[0].content[0] as vscode.LanguageModelTextPart).value,
        "Reusable system prompt",
      );
    });

    test("should return empty array for undefined system", () => {
      const result = convertAnthropicSystemToVSCode(undefined);
      assert.strictEqual(result.length, 0);
    });

    test("should return empty array for empty string", () => {
      const result = convertAnthropicSystemToVSCode("");
      assert.strictEqual(result.length, 0);
    });
  });

  suite("convertAnthropicToolToVSCode", () => {
    test("should convert standard tool definition", () => {
      const tools = [
        {
          name: "get_weather",
          description: "Get the weather for a city",
          input_schema: {
            type: "object",
            properties: {
              city: { type: "string" },
            },
            required: ["city"],
          },
        },
      ];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "get_weather");
      assert.strictEqual(result[0].description, "Get the weather for a city");
    });

    test("should ignore cache_control metadata on tools", () => {
      const tools = [
        {
          name: "cached_lookup",
          description: "Lookup using cached context",
          input_schema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
          cache_control: { type: "ephemeral" },
        },
      ];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "cached_lookup");
      assert.strictEqual(result[0].description, "Lookup using cached context");
      assert.deepStrictEqual(result[0].inputSchema, tools[0].input_schema);
    });

    test("should drop unsupported server-side tools without input_schema", () => {
      const tools = [
        { name: "bash", type: "bash_20250124" },
        { name: "web_search", type: "web_search_20250305", max_uses: 5 },
        { name: "computer", type: "computer_20250124" },
        {
          name: "get_weather",
          input_schema: {
            type: "object",
            properties: { city: { type: "string" } },
          },
        },
      ];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(
        result.length,
        1,
        "server-side tools without input_schema should be dropped",
      );
      assert.strictEqual(result[0].name, "get_weather");
      assert.deepStrictEqual(result[0].inputSchema, tools[3].input_schema);
    });

    test("should keep custom tools with type: 'custom'", () => {
      const tools = [
        {
          name: "lookup",
          type: "custom",
          description: "Look something up",
          input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "lookup");
      assert.strictEqual(result[0].description, "Look something up");
      assert.deepStrictEqual(result[0].inputSchema, tools[0].input_schema);
    });

    test("should return undefined for undefined tools", () => {
      const result = convertAnthropicToolToVSCode(undefined);
      assert.strictEqual(result, undefined);
    });

    test("should handle tool without description", () => {
      const tools = [
        {
          name: "simple_tool",
          input_schema: { type: "object" },
        },
      ];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result[0].name, "simple_tool");
      assert.strictEqual(result[0].description, "");
    });
  });

  suite("convertAnthropicToolChoiceToVSCode", () => {
    test("should convert auto tool choice", () => {
      const result = convertAnthropicToolChoiceToVSCode({ type: "auto" });
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Auto);
    });

    test("should convert any tool choice to Required", () => {
      const result = convertAnthropicToolChoiceToVSCode({ type: "any" });
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Required);
    });

    test("should convert specific tool choice to Required", () => {
      const result = convertAnthropicToolChoiceToVSCode({
        type: "tool",
        name: "get_weather",
      });
      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Required);
    });

    test("should return undefined for none tool choice", () => {
      const result = convertAnthropicToolChoiceToVSCode({
        type: "none",
      } as any);
      assert.strictEqual(result, undefined);
    });

    test("should return undefined for undefined tool choice", () => {
      const result = convertAnthropicToolChoiceToVSCode(undefined);
      assert.strictEqual(result, undefined);
    });
  });

  suite("Anthropic max_tokens length stop handling", () => {
    test("should detect Copilot response-too-long errors", () => {
      const error = new Error("Response too long.");

      assert.strictEqual(isResponseTooLongError(error), true);
    });

    test("should return false for non-length errors", () => {
      assert.strictEqual(
        isResponseTooLongError(new Error("network failure")),
        false,
      );
    });

    test("should return false for non-Error values", () => {
      assert.strictEqual(isResponseTooLongError("Response too long"), false);
      assert.strictEqual(isResponseTooLongError(null), false);
      assert.strictEqual(isResponseTooLongError(undefined), false);
    });
  });
});
