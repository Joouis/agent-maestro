import * as assert from "assert";
import * as vscode from "vscode";

import {
  convertAnthropicMessageToVSCode,
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
  extractAnthropicTokenUsageFromVSCodeChunk,
} from "../../server/utils/anthropic";
import {
  createAnthropicModelsResponse,
  findAnthropicModelById,
} from "../../server/utils/anthropicModels";
import { isResponseTooLongError } from "../../server/utils/languageModelErrors";

function createMockModel(
  overrides: Partial<vscode.LanguageModelChat> & {
    capabilities?: {
      supportsImageToText?: boolean;
      supportsToolCalling?: boolean;
    };
  },
): vscode.LanguageModelChat {
  return {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    family: "claude",
    version: "4.6",
    vendor: "copilot",
    maxInputTokens: 200000,
    capabilities: {
      supportsImageToText: false,
      supportsToolCalling: true,
    },
    sendRequest: async () => {
      throw new Error("not implemented");
    },
    countTokens: async () => 0,
    ...overrides,
  } as vscode.LanguageModelChat;
}

suite("Anthropic Conversion Utils Test Suite", () => {
  suite("createAnthropicModelsResponse", () => {
    test("should expose max_input_tokens from Claude models", () => {
      const result = createAnthropicModelsResponse([
        createMockModel({
          id: "claude-opus-4.7",
          name: "Claude Opus 4.7",
          maxInputTokens: 1000000,
        }),
      ]);

      assert.strictEqual(result.data.length, 1);
      assert.strictEqual(result.data[0].id, "claude-opus-4.7");
      assert.strictEqual(result.data[0].display_name, "Claude Opus 4.7");
      assert.strictEqual(result.data[0].max_input_tokens, 1000000);
      assert.strictEqual(
        result.data[0].capabilities?.image_input.supported,
        false,
      );
      assert.strictEqual(
        result.data[0].capabilities?.structured_outputs.supported,
        true,
      );
      assert.strictEqual(result.data[0].type, "model");
      assert.strictEqual(result.data[0].max_tokens, null);
      assert.strictEqual(result.first_id, "claude-opus-4.7");
      assert.strictEqual(result.last_id, "claude-opus-4.7");
      assert.strictEqual(result.has_more, false);
    });

    test("should preserve zero max_input_tokens", () => {
      const result = createAnthropicModelsResponse([
        createMockModel({ maxInputTokens: 0 }),
      ]);

      assert.strictEqual(result.data[0].max_input_tokens, 0);
    });

    test("should translate known VS Code capabilities", () => {
      const result = createAnthropicModelsResponse([
        createMockModel({
          capabilities: {
            supportsImageToText: true,
            supportsToolCalling: false,
          },
        }),
      ]);

      assert.strictEqual(
        result.data[0].capabilities?.image_input.supported,
        true,
      );
      assert.strictEqual(
        result.data[0].capabilities?.structured_outputs.supported,
        false,
      );
      assert.strictEqual(
        result.data[0].capabilities?.code_execution.supported,
        false,
      );
      assert.strictEqual(
        result.data[0].capabilities?.thinking.supported,
        false,
      );
    });

    test("should omit non-Claude models", () => {
      const result = createAnthropicModelsResponse([
        createMockModel({
          id: "gpt-5.1",
          name: "GPT-5.1",
          family: "gpt",
        }),
      ]);

      assert.deepStrictEqual(result.data, []);
      assert.strictEqual(result.first_id, null);
      assert.strictEqual(result.last_id, null);
    });

    test("should find one Claude model by exact id", () => {
      const result = findAnthropicModelById(
        [
          createMockModel({ id: "claude-sonnet-4.6" }),
          createMockModel({
            id: "claude-opus-4.7",
            name: "Claude Opus 4.7",
            maxInputTokens: 1000000,
          }),
        ],
        "claude-opus-4.7",
      );

      assert.ok(result);
      assert.strictEqual(result.id, "claude-opus-4.7");
      assert.strictEqual(result.max_input_tokens, 1000000);
    });

    test("should not find non-Claude or unknown model ids", () => {
      const result = findAnthropicModelById(
        [
          createMockModel({
            id: "gpt-5.1",
            name: "GPT-5.1",
            family: "gpt",
          }),
        ],
        "gpt-5.1",
      );

      assert.strictEqual(result, null);
    });
  });

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
      // URL images fall back to text, while base64 image blocks use DataPart.
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

  suite("extractAnthropicTokenUsageFromVSCodeChunk", () => {
    const encode = (value: unknown): Uint8Array =>
      new TextEncoder().encode(JSON.stringify(value));

    test("should extract usage and subtract cache tokens from input_tokens", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: {
            cache_creation_input_tokens: 200,
            cached_tokens: 300,
          },
        }),
      });

      assert.deepStrictEqual(result, {
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 300,
        input_tokens: 500,
        output_tokens: 50,
      });
    });

    test("should default cache fields to 0 when prompt_tokens_details is missing", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "usage",
        data: encode({ prompt_tokens: 100, completion_tokens: 20 }),
      });

      assert.deepStrictEqual(result, {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 20,
      });
    });

    test("should clamp input_tokens to 0 when cache totals exceed prompt_tokens", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: {
            cache_creation_input_tokens: 80,
            cached_tokens: 80,
          },
        }),
      });

      assert.strictEqual(result?.input_tokens, 0);
    });

    test("should return undefined for non-usage mimeType", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "image/png",
        data: encode({ prompt_tokens: 1, completion_tokens: 1 }),
      });

      assert.strictEqual(result, undefined);
    });

    test("should return undefined for invalid JSON", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "usage",
        data: new TextEncoder().encode("not json {"),
      });

      assert.strictEqual(result, undefined);
    });

    test("should return undefined when required fields are missing", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "usage",
        data: encode({ prompt_tokens: 100 }),
      });

      assert.strictEqual(result, undefined);
    });

    test("should reject non-finite or negative token counts", () => {
      assert.strictEqual(
        extractAnthropicTokenUsageFromVSCodeChunk({
          mimeType: "usage",
          data: encode({ prompt_tokens: -1, completion_tokens: 10 }),
        }),
        undefined,
      );

      assert.strictEqual(
        extractAnthropicTokenUsageFromVSCodeChunk({
          mimeType: "usage",
          data: encode({ prompt_tokens: 100, completion_tokens: "20" }),
        }),
        undefined,
      );
    });

    test("should ignore negative or non-finite cache fields", () => {
      const result = extractAnthropicTokenUsageFromVSCodeChunk({
        mimeType: "usage",
        data: encode({
          prompt_tokens: 100,
          completion_tokens: 10,
          prompt_tokens_details: {
            cache_creation_input_tokens: -5,
            cached_tokens: Number.POSITIVE_INFINITY,
          },
        }),
      });

      assert.deepStrictEqual(result, {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 10,
      });
    });
  });
});
