import * as assert from "assert";
import * as vscode from "vscode";

import {
  convertAnthropicMessageToVSCode,
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
  sanitizeOrphanedToolResults,
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
      const tools = [
        { name: "str_replace_editor", type: "text_editor_20250124" },
      ];

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

  suite("sanitizeOrphanedToolResults", () => {
    test("should pass through messages with no tool_results", () => {
      const messages = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there!" },
        { role: "user" as const, content: "How are you?" },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      assert.deepStrictEqual(result, messages);
    });

    test("should pass through valid tool_use/tool_result pairing", () => {
      const messages = [
        { role: "user" as const, content: "Use a tool" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "tool-123",
              name: "get_weather",
              input: { city: "NYC" },
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-123",
              content: "Sunny",
            },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      assert.strictEqual(result.length, 3);
      assert.strictEqual((result[2].content as any[]).length, 1);
    });

    test("should remove orphaned tool_result with no preceding assistant", () => {
      const messages = [
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-orphan",
              content: "Result",
            },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      // The user message is dropped entirely since it only had the orphaned tool_result
      assert.strictEqual(result.length, 0);
    });

    test("should remove orphaned tool_result when preceding assistant has no tool_use", () => {
      const messages = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "I'll help you" },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-orphan",
              content: "Result from compacted-away tool",
            },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      // User message with only orphaned tool_result is dropped, then
      // the two remaining messages are user + assistant (no merge needed)
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].role, "user");
      assert.strictEqual(result[1].role, "assistant");
    });

    test("should keep text blocks and remove only orphaned tool_results", () => {
      const messages = [
        { role: "user" as const, content: "Use a tool" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "tool-valid",
              name: "search",
              input: {},
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-valid",
              content: "Valid result",
            },
            {
              type: "tool_result" as const,
              tool_use_id: "tool-orphan",
              content: "Orphaned result",
            },
            { type: "text" as const, text: "Some text" },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      assert.strictEqual(result.length, 3);
      const lastContent = result[2].content as any[];
      assert.strictEqual(lastContent.length, 2);
      assert.strictEqual(lastContent[0].type, "tool_result");
      assert.strictEqual(lastContent[0].tool_use_id, "tool-valid");
      assert.strictEqual(lastContent[1].type, "text");
    });

    test("should merge consecutive same-role messages after removal", () => {
      const messages = [
        { role: "user" as const, content: "First user message" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "tool-1",
              name: "search",
              input: {},
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-1",
              content: "Result 1",
            },
          ],
        },
        // This assistant message was compacted away in the original history,
        // but we simulate the scenario where orphaned results appear:
        { role: "assistant" as const, content: "Some text response" },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-compacted-away",
              content: "Orphaned result",
            },
          ],
        },
        { role: "user" as const, content: "Follow-up question" },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      // After removing the orphaned tool_result message (index 4),
      // the two user messages at the end (original index 4 dropped, index 5 remains)
      // would result in assistant at index 3 followed by user at index 5 — no merge needed
      // But let's verify the structure is correct
      assert.ok(result.length >= 4);
      // Verify alternation is maintained
      for (let i = 1; i < result.length; i++) {
        if (result[i].role === result[i - 1].role) {
          // Same-role messages should have been merged
          assert.fail(
            `Consecutive same-role messages at index ${i - 1} and ${i}`,
          );
        }
      }
    });

    test("should handle empty messages array", () => {
      const result = sanitizeOrphanedToolResults([]);
      assert.strictEqual(result.length, 0);
    });

    test("should handle web_search_tool_result blocks", () => {
      const messages = [
        { role: "user" as const, content: "Search something" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "server_tool_use" as const,
              id: "srvtool-1",
              name: "web_search",
              input: { query: "test" },
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "web_search_tool_result" as const,
              tool_use_id: "srvtool-1",
              content: [
                {
                  type: "web_search_result" as const,
                  url: "https://example.com",
                  title: "Example",
                  encrypted_content: "abc",
                  page_age: "1d",
                },
              ],
            },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages as any);

      // Valid pairing with server_tool_use, should pass through
      assert.strictEqual(result.length, 3);
    });

    test("should remove orphaned web_search_tool_result blocks", () => {
      const messages = [
        { role: "user" as const, content: "Search something" },
        { role: "assistant" as const, content: "I found some info" },
        {
          role: "user" as const,
          content: [
            {
              type: "web_search_tool_result" as const,
              tool_use_id: "srvtool-orphan",
              content: [],
            },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages as any);

      // The orphaned web_search_tool_result message is dropped
      assert.strictEqual(result.length, 2);
    });

    test("should handle string content in preceding assistant message", () => {
      const messages = [
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Just a text response" },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool-orphan",
              content: "Orphaned",
            },
            { type: "text" as const, text: "But also some text" },
          ],
        },
      ];

      const result = sanitizeOrphanedToolResults(messages);

      // The tool_result is removed but the text block remains
      assert.strictEqual(result.length, 3);
      const lastContent = result[2].content as any[];
      assert.strictEqual(lastContent.length, 1);
      assert.strictEqual(lastContent[0].type, "text");
    });
  });
});
