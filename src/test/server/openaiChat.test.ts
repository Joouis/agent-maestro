import * as assert from "assert";
import * as vscode from "vscode";

import {
  convertOpenAIChatCompletionToolToVSCode,
  convertOpenAIMessagesToVSCode,
} from "../../server/utils/openaiChat";

suite("OpenAI Conversion Utils Test Suite", () => {
  suite("convertOpenAIMessagesToVSCode", () => {
    test("should convert system message to User role", () => {
      const messages = [
        { role: "system" as const, content: "You are a helpful assistant" },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert developer message to User role", () => {
      const messages = [
        { role: "developer" as const, content: "System instructions here" },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert user message with string content", () => {
      const messages = [{ role: "user" as const, content: "Hello!" }];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert user message with array content", () => {
      const messages = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Look at this image" }],
        },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert assistant message with string content", () => {
      const messages = [
        { role: "assistant" as const, content: "I can help with that!" },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should convert assistant message with tool calls", () => {
      const messages = [
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: {
                name: "get_weather",
                arguments: '{"city": "New York"}',
              },
            },
          ],
        },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should convert tool message to User with ToolResultPart", () => {
      const messages = [
        {
          role: "tool" as const,
          content: "The weather is sunny",
          tool_call_id: "call_123",
        },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should handle multi-turn conversation", () => {
      const messages = [
        { role: "system" as const, content: "You are helpful" },
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there!" },
        { role: "user" as const, content: "What can you do?" },
        { role: "assistant" as const, content: "Many things!" },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 5);
    });

    test("should handle empty messages array", () => {
      const result = convertOpenAIMessagesToVSCode([]);
      assert.strictEqual(result.length, 0);
    });

    test("should handle assistant message with array content", () => {
      const messages = [
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "Part one" },
            { type: "text" as const, text: "Part two" },
          ],
        },
      ];

      const result = convertOpenAIMessagesToVSCode(messages);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should handle malformed function arguments gracefully", () => {
      const messages = [
        {
          role: "assistant" as const,
          content: "",
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: {
                name: "test_function",
                arguments: "invalid json {{{",
              },
            },
          ],
        },
      ];

      // Should not throw
      const result = convertOpenAIMessagesToVSCode(messages);
      assert.strictEqual(result.length, 1);
    });
  });

  suite("convertOpenAIChatCompletionToolToVSCode", () => {
    test("should convert function tool definition", () => {
      const tool = {
        type: "function" as const,
        function: {
          name: "get_weather",
          description: "Get the current weather",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      };

      const result = convertOpenAIChatCompletionToolToVSCode(tool);

      assert.strictEqual(result.name, "get_weather");
      assert.strictEqual(result.description, "Get the current weather");
      assert.ok(result.inputSchema);
    });

    test("should handle function without description", () => {
      const tool = {
        type: "function" as const,
        function: {
          name: "simple_function",
          parameters: { type: "object" },
        },
      };

      const result = convertOpenAIChatCompletionToolToVSCode(tool);

      assert.strictEqual(result.name, "simple_function");
      assert.strictEqual(result.description, "");
    });

    test("should handle function without parameters", () => {
      const tool = {
        type: "function" as const,
        function: {
          name: "no_params",
          description: "A function with no parameters",
        },
      };

      const result = convertOpenAIChatCompletionToolToVSCode(tool);

      assert.strictEqual(result.name, "no_params");
      assert.strictEqual(result.description, "A function with no parameters");
    });

    test("should handle custom tool type", () => {
      const tool = {
        type: "custom" as const,
        custom: {
          name: "custom_tool",
          description: "A custom tool",
          format: { type: "object" },
        },
      };

      const result = convertOpenAIChatCompletionToolToVSCode(tool as any);

      assert.strictEqual(result.name, "custom_tool");
      assert.strictEqual(result.description, "A custom tool");
    });
  });
});
