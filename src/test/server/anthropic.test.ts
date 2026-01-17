import * as assert from "assert";
import * as vscode from "vscode";

import {
  convertAnthropicMessageToVSCode,
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
} from "../../server/utils/anthropic";

suite("Anthropic Conversion Utils Test Suite", () => {
  suite("convertAnthropicMessageToVSCode", () => {
    test("should convert user message with string content", () => {
      const message = {
        role: "user" as const,
        content: "Hello, how are you?",
      };

      const result = convertAnthropicMessageToVSCode(message);

      assert.ok(!Array.isArray(result));
      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
      );
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
      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
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
      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
      );
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
      const result = convertAnthropicSystemToVSCode("You are a helpful assistant");

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

    test("should handle bash tool specially", () => {
      const tools = [{ name: "bash", type: "bash_20250124" }];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result[0].name, "bash");
      assert.strictEqual(result[0].description, "ToolBash20250124");
    });

    test("should handle str_replace_editor tool specially", () => {
      const tools = [{ name: "str_replace_editor", type: "text_editor_20250124" }];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result[0].name, "str_replace_editor");
      assert.strictEqual(result[0].description, "ToolTextEditor20250124");
    });

    test("should handle web_search tool specially", () => {
      const tools = [{ name: "web_search", type: "web_search_20250305" }];

      const result = convertAnthropicToolToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result[0].name, "web_search");
      assert.strictEqual(result[0].description, "WebSearchTool20250305");
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
      const result = convertAnthropicToolChoiceToVSCode({ type: "none" } as any);
      assert.strictEqual(result, undefined);
    });

    test("should return undefined for undefined tool choice", () => {
      const result = convertAnthropicToolChoiceToVSCode(undefined);
      assert.strictEqual(result, undefined);
    });
  });
});
