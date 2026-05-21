import Anthropic from "@anthropic-ai/sdk";
import * as assert from "assert";
import * as vscode from "vscode";

import {
  OrphanToolResultError,
  convertAnthropicMessageToVSCode,
  convertAnthropicMessagesToVSCode,
  convertAnthropicSystemToVSCode,
  convertAnthropicToolChoiceToVSCode,
  convertAnthropicToolToVSCode,
  extractAnthropicTokenUsageFromVSCodeChunk,
  isDownstreamTruncationOrphan,
  isInputAtOrOverCapacity,
  validateAnthropicToolPairing,
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

  suite("validateAnthropicToolPairing", () => {
    const textUser = (text: string): Anthropic.Messages.MessageParam => ({
      role: "user",
      content: text,
    });

    const toolUse = (
      id: string,
      name = "do_thing",
    ): Anthropic.Messages.ToolUseBlockParam => ({
      type: "tool_use",
      id,
      name,
      input: {},
    });

    const toolResult = (
      tool_use_id: string,
      content: string | null = "ok",
    ): Anthropic.Messages.ToolResultBlockParam =>
      content === null
        ? ({ type: "tool_result", tool_use_id } as any)
        : { type: "tool_result", tool_use_id, content };

    const assistantBlocks = (
      ...blocks: Anthropic.Messages.ContentBlockParam[]
    ): Anthropic.Messages.MessageParam => ({
      role: "assistant",
      content: blocks as Anthropic.Messages.ContentBlockParam[],
    });

    const userBlocks = (
      ...blocks: Anthropic.Messages.ContentBlockParam[]
    ): Anthropic.Messages.MessageParam => ({
      role: "user",
      content: blocks as Anthropic.Messages.ContentBlockParam[],
    });

    test("empty messages array is ok", () => {
      assert.deepStrictEqual(validateAnthropicToolPairing([]), { ok: true });
    });

    test("string-content messages with no tool blocks are ok", () => {
      assert.deepStrictEqual(
        validateAnthropicToolPairing([
          textUser("hi"),
          { role: "assistant", content: "hello" },
        ]),
        { ok: true },
      );
    });

    test("matched tool_use → tool_result is ok", () => {
      const result = validateAnthropicToolPairing([
        textUser("call my tool"),
        assistantBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_A")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("tool_result with no matching prior tool_use is orphan", () => {
      const result = validateAnthropicToolPairing([
        textUser("hi"),
        assistantBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_B")),
      ]);
      assert.deepStrictEqual(result, {
        ok: false,
        orphanIds: ["call_B"],
      });
    });

    test("tool_result with no prior tool_use at all is orphan", () => {
      const result = validateAnthropicToolPairing([
        userBlocks(toolResult("call_X")),
      ]);
      assert.deepStrictEqual(result, {
        ok: false,
        orphanIds: ["call_X"],
      });
    });

    test("tool_use with no follow-up tool_result is allowed (in-flight)", () => {
      const result = validateAnthropicToolPairing([
        textUser("call my tool"),
        assistantBlocks(toolUse("call_A")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("multiple tool_uses in one message, all matched in next is ok", () => {
      const result = validateAnthropicToolPairing([
        textUser("call both"),
        assistantBlocks(toolUse("call_A"), toolUse("call_B")),
        userBlocks(toolResult("call_A"), toolResult("call_B")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("multiple tool_uses but only one answered is ok (other in-flight)", () => {
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolUse("call_A"), toolUse("call_B")),
        userBlocks(toolResult("call_A")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("multiple tool_results for the same id are tolerated", () => {
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_A"), toolResult("call_A", "again")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("duplicate tool_use ids across messages are tolerated", () => {
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_A")),
        assistantBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_A")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("mixed text and tool blocks with valid pairing is ok", () => {
      const result = validateAnthropicToolPairing([
        textUser("question"),
        assistantBlocks(
          { type: "text", text: "let me look that up" },
          toolUse("call_A"),
        ),
        userBlocks(
          { type: "text", text: "extra context" },
          toolResult("call_A"),
        ),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("tool_result before its tool_use (out of order) is orphan", () => {
      const result = validateAnthropicToolPairing([
        userBlocks(toolResult("call_A")),
        assistantBlocks(toolUse("call_A")),
      ]);
      assert.deepStrictEqual(result, {
        ok: false,
        orphanIds: ["call_A"],
      });
    });

    test("two distinct orphan ids are de-duplicated and reported", () => {
      const result = validateAnthropicToolPairing([
        userBlocks(
          toolResult("call_X"),
          toolResult("call_Y"),
          toolResult("call_X"),
        ),
      ]);
      assert.strictEqual((result as { ok: false }).ok, false);
      const { orphanIds } = result as { ok: false; orphanIds: string[] };
      // Explicit length assertion: a regression that double-reports call_X
      // would still pass deepStrictEqual on the sorted unique array but the
      // length check makes the dedup contract a first-class assertion.
      assert.strictEqual(orphanIds.length, 2);
      assert.deepStrictEqual(orphanIds.slice().sort(), ["call_X", "call_Y"]);
    });

    test("server_tool_use ids satisfy their matching tool_result", () => {
      const result = validateAnthropicToolPairing([
        assistantBlocks({
          type: "server_tool_use",
          id: "srv_A",
          name: "web_search",
          input: {},
        } as Anthropic.Messages.ServerToolUseBlockParam),
        userBlocks(toolResult("srv_A")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("ignores blocks that aren't recognisable objects", () => {
      const result = validateAnthropicToolPairing([
        {
          role: "user",
          content: [
            null as unknown as Anthropic.Messages.ContentBlockParam,
            { type: "text", text: "hi" },
          ],
        },
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("OrphanToolResultError carries the offending ids", () => {
      const err = new OrphanToolResultError(["call_A", "call_B"]);
      assert.strictEqual(err.name, "OrphanToolResultError");
      assert.deepStrictEqual(err.orphanIds, ["call_A", "call_B"]);
      // The message wording is part of the contract — the routes layer
      // surfaces it in the 400 response body and in the diagnostic log file.
      // Lock the prefix so accidental rewording is caught here, not by users.
      assert.ok(
        err.message.startsWith(
          "Request contains tool_result block(s) with no matching tool_use",
        ),
        `unexpected message prefix: ${err.message}`,
      );
      assert.ok(err.message.includes("call_A"));
      assert.ok(err.message.includes("call_B"));
    });

    test("OrphanToolResultError survives instanceof after throw/catch", () => {
      let caught: unknown;
      try {
        throw new OrphanToolResultError(["call_X"]);
      } catch (e) {
        caught = e;
      }
      assert.ok(caught instanceof OrphanToolResultError);
      assert.ok(caught instanceof Error);
    });

    test("non-array messages input does not throw", () => {
      assert.deepStrictEqual(validateAnthropicToolPairing(undefined as any), {
        ok: true,
      });
      assert.deepStrictEqual(validateAnthropicToolPairing(null as any), {
        ok: true,
      });
    });

    test("null message entry is skipped, not thrown on", () => {
      assert.deepStrictEqual(
        validateAnthropicToolPairing([
          null as any,
          assistantBlocks(toolUse("call_A")),
          userBlocks(toolResult("call_A")),
        ]),
        { ok: true },
      );
    });

    test("null/missing message.content is skipped, not thrown on", () => {
      assert.deepStrictEqual(
        validateAnthropicToolPairing([
          { role: "user", content: null as any },
          { role: "assistant", content: undefined as any },
          assistantBlocks(toolUse("call_A")),
          userBlocks(toolResult("call_A")),
        ]),
        { ok: true },
      );
    });

    test("non-array, non-string message.content is skipped", () => {
      assert.deepStrictEqual(
        validateAnthropicToolPairing([
          { role: "user", content: { weird: true } as any },
        ]),
        { ok: true },
      );
    });

    test("tool_use in a user message does NOT register its id", () => {
      // A tool_use block in a user message is itself protocol-illegal.
      // Treating it as a known id would let a follow-up tool_result silently
      // pass our check even though the upstream API rejects the conversation.
      const result = validateAnthropicToolPairing([
        userBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_A")),
      ]);
      assert.deepStrictEqual(result, {
        ok: false,
        orphanIds: ["call_A"],
      });
    });

    test("tool_use and matching tool_result inside the same message is tolerated", () => {
      // Conservative by design: this shape is uncommon but not provably
      // malformed, so we do not flag it. See the design notes on the
      // validator for the false-positive vs false-negative trade-off.
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolUse("call_A"), toolResult("call_A") as any),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("same-message pairing is order-independent within the message", () => {
      // Regression: a single forward pass would flag this as orphan because
      // the tool_result block is visited before the tool_use registers its
      // id. The validator must scan each message in two passes (register
      // first, then check) so its verdict only depends on message order,
      // not intra-message block order.
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolResult("call_A") as any, toolUse("call_A")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("web_search_tool_result paired with server_tool_use is ok", () => {
      const result = validateAnthropicToolPairing([
        assistantBlocks({
          type: "server_tool_use",
          id: "srv_A",
          name: "web_search",
          input: {},
        } as Anthropic.Messages.ServerToolUseBlockParam),
        userBlocks({
          type: "web_search_tool_result",
          tool_use_id: "srv_A",
          content: [],
        } as Anthropic.Messages.WebSearchToolResultBlockParam),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("web_search_tool_result with no matching server_tool_use is orphan", () => {
      const result = validateAnthropicToolPairing([
        userBlocks({
          type: "web_search_tool_result",
          tool_use_id: "srv_missing",
          content: [],
        } as Anthropic.Messages.WebSearchToolResultBlockParam),
      ]);
      assert.deepStrictEqual(result, {
        ok: false,
        orphanIds: ["srv_missing"],
      });
    });

    test("extended SDK result block types are recognised as orphan when unmatched", () => {
      // The validator hard-codes the list of SDK result block types that
      // carry a `tool_use_id` (RESULT_BLOCK_TYPES). If a future SDK upgrade
      // adds a new variant and we forget to extend that set, this regression
      // test will fail loudly: each block here represents a real SDK type.
      const results: Anthropic.Messages.ContentBlockParam[] = [
        {
          type: "code_execution_tool_result",
          tool_use_id: "code_missing",
          content: { type: "code_execution_result" },
        } as unknown as Anthropic.Messages.ContentBlockParam,
        {
          type: "bash_code_execution_tool_result",
          tool_use_id: "bash_missing",
          content: { type: "bash_code_execution_result" },
        } as unknown as Anthropic.Messages.ContentBlockParam,
        {
          type: "text_editor_code_execution_tool_result",
          tool_use_id: "te_missing",
          content: { type: "text_editor_code_execution_view_result" },
        } as unknown as Anthropic.Messages.ContentBlockParam,
        {
          type: "tool_search_tool_result",
          tool_use_id: "ts_missing",
          content: [],
        } as unknown as Anthropic.Messages.ContentBlockParam,
        {
          type: "web_fetch_tool_result",
          tool_use_id: "wf_missing",
          content: { type: "web_fetch_result" },
        } as unknown as Anthropic.Messages.ContentBlockParam,
      ];
      const result = validateAnthropicToolPairing([userBlocks(...results)]);
      assert.strictEqual((result as { ok: false }).ok, false);
      const { orphanIds } = result as { ok: false; orphanIds: string[] };
      assert.deepStrictEqual(
        orphanIds.slice().sort(),
        [
          "bash_missing",
          "code_missing",
          "te_missing",
          "wf_missing",
          "ts_missing",
        ].sort(),
      );
    });

    test("validator is pure: repeated calls on the same input give the same result and don't mutate", () => {
      // The validator builds local Sets per call and reads `messages` only.
      // Pin that contract so a future "optimisation" that hoists state to
      // module scope (or mutates input arrays) is caught here.
      const messages: Array<Anthropic.Messages.MessageParam> = [
        assistantBlocks(toolUse("call_A")),
        userBlocks(toolResult("call_A"), toolResult("call_X")),
      ];
      const snapshot = JSON.stringify(messages);
      const first = validateAnthropicToolPairing(messages);
      const second = validateAnthropicToolPairing(messages);
      assert.deepStrictEqual(first, second);
      assert.deepStrictEqual(first, { ok: false, orphanIds: ["call_X"] });
      assert.strictEqual(JSON.stringify(messages), snapshot);
    });

    test("tool_result in an assistant message (protocol-illegal) does not crash", () => {
      // We don't police misplaced blocks, but the verdict still has to be
      // *correct*: an assistant-role tool_result whose id was never registered
      // (no assistant tool_use anywhere) IS an orphan and must be reported as
      // such. Previously this test only checked `typeof ok === "boolean"`,
      // which would accept either verdict — losing the regression signal if
      // future code paths silently swallowed this case.
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolResult("call_A") as any),
      ]);
      assert.deepStrictEqual(result, {
        ok: false,
        orphanIds: ["call_A"],
      });
    });

    test("tool_use with empty-string id is ignored (cannot be 'known')", () => {
      // An empty id can never satisfy a later tool_result's tool_use_id
      // lookup, so we deliberately do not register it. The follow-up
      // tool_result referencing the same empty string is therefore orphan —
      // but tool_use_id="" is itself filtered out by the result-side guard
      // (length === 0), so the net verdict is ok. Locking this behavior
      // documents that empty ids are *both* unregisterable and unreportable.
      const result = validateAnthropicToolPairing([
        assistantBlocks(toolUse("")),
        userBlocks(toolResult("")),
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });

    test("blocks missing a `type` field are skipped, not thrown on", () => {
      // Hostile / malformed payloads (e.g. `{}` slipped through schema
      // validation) must not crash the validator. The "type" key guard is
      // the only line of defense before property access.
      const result = validateAnthropicToolPairing([
        {
          role: "user",
          content: [{} as Anthropic.Messages.ContentBlockParam],
        },
      ]);
      assert.deepStrictEqual(result, { ok: true });
    });
  });

  suite("isDownstreamTruncationOrphan", () => {
    test("matches the exact upstream orphan tool_use_id error", () => {
      // Real-world payload (paraphrased) — note the backticks must stay.
      const msg =
        "messages.3.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01ABC. Each `tool_result` block must have a corresponding `tool_use` block in the previous message.";
      assert.strictEqual(isDownstreamTruncationOrphan(msg), true);
    });

    test("does not match unrelated errors", () => {
      assert.strictEqual(
        isDownstreamTruncationOrphan("Request failed: rate_limit_error"),
        false,
      );
      assert.strictEqual(
        isDownstreamTruncationOrphan("model_not_supported"),
        false,
      );
      assert.strictEqual(
        isDownstreamTruncationOrphan("Response too long"),
        false,
      );
      assert.strictEqual(isDownstreamTruncationOrphan(""), false);
    });

    test("does not match a paraphrased orphan message without the canonical substring", () => {
      // If Anthropic ever changes wording, we explicitly want this to start
      // returning false so the test signals the regression rather than
      // silently broadening the trigger.
      assert.strictEqual(
        isDownstreamTruncationOrphan(
          "tool_result references an unknown tool_use id",
        ),
        false,
      );
    });
  });

  suite("isInputAtOrOverCapacity", () => {
    test("returns true when calibrated input equals max input tokens", () => {
      // The boundary case: at exactly the cap we still translate, because
      // Copilot's truncation kicks in at-or-above the cap, not strictly above.
      assert.strictEqual(isInputAtOrOverCapacity(200_000, 200_000), true);
    });

    test("returns true when calibrated input exceeds max input tokens", () => {
      assert.strictEqual(isInputAtOrOverCapacity(250_000, 200_000), true);
    });

    test("returns false when calibrated input is below max input tokens", () => {
      // The capacity-clear case: routes use this to decide that an orphan
      // error is a Copilot-side bug rather than a truncation event.
      assert.strictEqual(isInputAtOrOverCapacity(150_000, 200_000), false);
    });

    test("returns false when calibrated input is at the typical scale-factor band but still under cap", () => {
      // tokenCountScaleFactor default is 1.25, so a calibrated value of
      // 160k on a 200k model corresponds to a raw count of 128k (64%) —
      // well below the truncation band. Pin this so a future "looser"
      // capacity check that uses a percentage threshold is caught here.
      assert.strictEqual(isInputAtOrOverCapacity(160_000, 200_000), false);
    });

    test("returns false when maxInputTokens is 0 (model didn't advertise a cap)", () => {
      // Some VS Code models report maxInputTokens as 0; with no cap to
      // reason about, we cannot conclude capacity-driven truncation, so
      // the orphan must be treated as a bug (rethrow path) by the caller.
      assert.strictEqual(isInputAtOrOverCapacity(150_000, 0), false);
    });

    test("returns false for negative or non-finite maxInputTokens", () => {
      assert.strictEqual(isInputAtOrOverCapacity(150_000, -1), false);
      assert.strictEqual(isInputAtOrOverCapacity(150_000, NaN), false);
      assert.strictEqual(
        isInputAtOrOverCapacity(150_000, Number.POSITIVE_INFINITY),
        false,
      );
    });

    test("returns false for zero inputTokens against a positive cap", () => {
      // A request that hasn't been counted yet shouldn't be classified as
      // capacity-driven — the comparison against a positive cap will be
      // 0 >= cap, which is false.
      assert.strictEqual(isInputAtOrOverCapacity(0, 200_000), false);
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
