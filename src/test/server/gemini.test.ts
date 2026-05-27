import { FunctionCallingConfigMode } from "@google/genai";
import * as assert from "assert";
import * as vscode from "vscode";

import {
  convertGeminiContentToVSCode,
  convertGeminiContentsToVSCode,
  convertGeminiSystemInstructionToVSCode,
  convertGeminiToolConfigToVSCode,
  convertGeminiToolsToVSCode,
  extractGeminiUsage,
  normalizeSchemaTypes,
} from "../../server/utils/gemini";

suite("Gemini Conversion Utils Test Suite", () => {
  suite("extractGeminiUsage", () => {
    const usagePart = (usage: unknown) =>
      new vscode.LanguageModelDataPart(
        Buffer.from(JSON.stringify(usage)),
        "usage",
      );

    test("should parse uncached Copilot usage", () => {
      const result = extractGeminiUsage(
        usagePart({
          completion_tokens: 406,
          prompt_tokens: 16748,
          prompt_tokens_details: { cached_tokens: 0 },
          total_tokens: 17154,
          reasoning_tokens: 0,
        }),
      );

      assert.deepStrictEqual(result, {
        cachedContentTokenCount: 0,
        candidatesTokenCount: 406,
        promptTokenCount: 16748,
        thoughtsTokenCount: 0,
        totalTokenCount: 17154,
      });
    });

    test("should subtract cached prompt tokens from promptTokenCount", () => {
      const result = extractGeminiUsage(
        usagePart({
          completion_tokens: 15,
          prompt_tokens: 14127,
          prompt_tokens_details: { cached_tokens: 13429 },
          total_tokens: 14142,
          reasoning_tokens: 0,
        }),
      );

      assert.deepStrictEqual(result, {
        cachedContentTokenCount: 13429,
        candidatesTokenCount: 15,
        promptTokenCount: 698,
        thoughtsTokenCount: 0,
        totalTokenCount: 14142,
      });
    });

    test("should map reasoning tokens to thoughtsTokenCount", () => {
      const result = extractGeminiUsage(
        usagePart({
          completion_tokens: 36,
          prompt_tokens: 14055,
          prompt_tokens_details: { cached_tokens: 0 },
          total_tokens: 14188,
          reasoning_tokens: 97,
        }),
      );

      assert.deepStrictEqual(result, {
        cachedContentTokenCount: 0,
        candidatesTokenCount: 36,
        promptTokenCount: 14055,
        thoughtsTokenCount: 97,
        totalTokenCount: 14188,
      });
    });

    test("should ignore invalid nested usage values", () => {
      const result = extractGeminiUsage(
        usagePart({
          completion_tokens: 20,
          completion_tokens_details: { reasoning_tokens: -7 },
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: -10 },
          reasoning_tokens: Number.NaN,
          total_tokens: -1,
        }),
      );

      assert.deepStrictEqual(result, {
        cachedContentTokenCount: 0,
        candidatesTokenCount: 20,
        promptTokenCount: 100,
        thoughtsTokenCount: 0,
        totalTokenCount: 120,
      });
    });
  });

  suite("convertGeminiContentToVSCode", () => {
    test("should convert user role with text part", () => {
      const content = {
        role: "user",
        parts: [{ text: "Hello, how are you?" }],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });

    test("should convert model role to Assistant", () => {
      const content = {
        role: "model",
        parts: [{ text: "I am doing well!" }],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should handle function call part", () => {
      const content = {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "get_weather",
              args: { city: "New York" },
            },
          },
        ],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.Assistant,
      );
    });

    test("should handle function response part", () => {
      const content = {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_123",
              name: "get_weather",
              response: { temperature: 72 },
            },
          },
        ],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });

    test("should handle multiple parts", () => {
      const content = {
        role: "user",
        parts: [
          { text: "First part" },
          { text: "Second part" },
          { text: "Third part" },
        ],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });

    test("should handle empty parts array", () => {
      const content = {
        role: "user",
        parts: [],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.ok(result); // Should not throw
    });

    test("should handle undefined parts", () => {
      const content = {
        role: "user",
      };

      const result = convertGeminiContentToVSCode(content as any);

      assert.ok(result); // Should not throw
    });

    test("should default to user role when role is undefined", () => {
      const content = {
        parts: [{ text: "No role specified" }],
      };

      const result = convertGeminiContentToVSCode(content as any);

      assert.strictEqual(result.role, vscode.LanguageModelChatMessageRole.User);
    });
  });

  suite("convertGeminiContentsToVSCode", () => {
    test("should convert array of contents", () => {
      const contents = [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "model", parts: [{ text: "Hi there!" }] },
        { role: "user", parts: [{ text: "How are you?" }] },
      ];

      const result = convertGeminiContentsToVSCode(contents);

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

    test("should handle empty contents array", () => {
      const result = convertGeminiContentsToVSCode([]);
      assert.strictEqual(result.length, 0);
    });

    test("should pair functionResponse without id via FIFO queue", () => {
      // langchain-google-genai 4.x emits functionResponse with only `name`
      // (no `id`). The pre-walk must assign a callId to the functionCall and
      // the second pass must drain the per-name FIFO queue to recover it.
      const contents = [
        {
          role: "model",
          parts: [
            { functionCall: { name: "fund_search", args: { q: "tech" } } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "fund_search",
                response: { result: "Found 026211" },
              },
            },
          ],
        },
      ];

      const result = convertGeminiContentsToVSCode(contents);

      assert.strictEqual(result.length, 2);
      const callPart = result[0].content[0] as vscode.LanguageModelToolCallPart;
      const resultPart = result[1]
        .content[0] as vscode.LanguageModelToolResultPart;
      assert.ok(callPart instanceof vscode.LanguageModelToolCallPart);
      assert.ok(resultPart instanceof vscode.LanguageModelToolResultPart);
      assert.strictEqual(
        resultPart.callId,
        callPart.callId,
        "functionResponse should inherit the callId of its paired functionCall",
      );
    });

    test("should not reuse an id-matched callId for a later id-less response", () => {
      // Two functionCalls for the same name. First response matches by id,
      // second response omits id. The second one must pair with the SECOND
      // call, not the first — i.e. the id-matched callId must be removed
      // from the FIFO queue when the explicit id consumes it.
      const contents = [
        {
          role: "model",
          parts: [
            { functionCall: { id: "call_A", name: "f", args: {} } },
            { functionCall: { id: "call_B", name: "f", args: {} } },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call_A",
                name: "f",
                response: { ok: 1 },
              },
            },
            {
              functionResponse: { name: "f", response: { ok: 2 } },
            },
          ],
        },
      ];

      const result = convertGeminiContentsToVSCode(contents);

      const responses = result[1]
        .content as vscode.LanguageModelToolResultPart[];
      assert.strictEqual(responses.length, 2);
      assert.strictEqual(responses[0].callId, "call_A");
      assert.strictEqual(
        responses[1].callId,
        "call_B",
        "id-less response must drain to call_B, not stale call_A",
      );
    });
  });

  suite("convertGeminiSystemInstructionToVSCode", () => {
    test("should convert system instruction with text", () => {
      const instruction = {
        parts: [{ text: "You are a helpful assistant" }],
      };

      const result = convertGeminiSystemInstructionToVSCode(instruction);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(
        result[0].role,
        vscode.LanguageModelChatMessageRole.User,
      );
    });

    test("should convert system instruction with multiple parts", () => {
      const instruction = {
        parts: [
          { text: "You are helpful" },
          { text: "Be concise" },
          { text: "Be accurate" },
        ],
      };

      const result = convertGeminiSystemInstructionToVSCode(instruction);

      // All parts combined into a single User message
      assert.strictEqual(result.length, 1);
    });

    test("should return empty array for undefined instruction", () => {
      const result = convertGeminiSystemInstructionToVSCode(undefined);
      assert.strictEqual(result.length, 0);
    });

    test("should return empty array for instruction with empty parts", () => {
      const instruction = { parts: [] };

      const result = convertGeminiSystemInstructionToVSCode(instruction);

      assert.strictEqual(result.length, 0);
    });
  });

  suite("convertGeminiToolsToVSCode", () => {
    test("should convert tools with function declarations", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Get weather for a city",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string" },
                },
              },
            },
          ],
        },
      ];

      const result = convertGeminiToolsToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "get_weather");
      assert.strictEqual(result[0].description, "Get weather for a city");
    });

    test("should handle multiple function declarations", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "func1",
              description: "First function",
              parameters: { type: "object" },
            },
            {
              name: "func2",
              description: "Second function",
              parameters: { type: "object" },
            },
          ],
        },
      ];

      const result = convertGeminiToolsToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 2);
    });

    test("should handle multiple tools objects", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "func1",
              description: "First",
              parameters: { type: "object" },
            },
          ],
        },
        {
          functionDeclarations: [
            {
              name: "func2",
              description: "Second",
              parameters: { type: "object" },
            },
          ],
        },
      ];

      const result = convertGeminiToolsToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 2);
    });

    test("should skip function declarations without name", () => {
      const tools = [
        {
          functionDeclarations: [
            {
              name: "valid_func",
              description: "Valid",
              parameters: { type: "object" },
            },
            { description: "No name", parameters: { type: "object" } }, // Should be skipped
          ],
        },
      ];

      const result = convertGeminiToolsToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, "valid_func");
    });

    test("should return undefined for undefined tools", () => {
      const result = convertGeminiToolsToVSCode(undefined);
      assert.strictEqual(result, undefined);
    });

    test("should return undefined for empty tools array", () => {
      const result = convertGeminiToolsToVSCode([]);
      assert.strictEqual(result, undefined);
    });

    test("should handle function without description", () => {
      const tools = [
        {
          functionDeclarations: [
            { name: "no_desc_func", parameters: { type: "object" } },
          ],
        },
      ];

      const result = convertGeminiToolsToVSCode(tools as any);

      assert.ok(result);
      assert.strictEqual(result[0].name, "no_desc_func");
      assert.strictEqual(result[0].description, "");
    });
  });

  suite("convertGeminiToolConfigToVSCode", () => {
    test("should convert AUTO mode", () => {
      const config = { mode: FunctionCallingConfigMode.AUTO };

      const result = convertGeminiToolConfigToVSCode(config);

      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Auto);
    });

    test("should convert VALIDATED mode to Auto", () => {
      const config = { mode: FunctionCallingConfigMode.VALIDATED };

      const result = convertGeminiToolConfigToVSCode(config);

      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Auto);
    });

    test("should convert ANY mode to Required", () => {
      const config = { mode: FunctionCallingConfigMode.ANY };

      const result = convertGeminiToolConfigToVSCode(config);

      assert.strictEqual(result, vscode.LanguageModelChatToolMode.Required);
    });

    test("should return undefined for NONE mode", () => {
      const config = { mode: FunctionCallingConfigMode.NONE };

      const result = convertGeminiToolConfigToVSCode(config);

      assert.strictEqual(result, undefined);
    });

    test("should return undefined for undefined config", () => {
      const result = convertGeminiToolConfigToVSCode(undefined);
      assert.strictEqual(result, undefined);
    });

    test("should return undefined for config without mode", () => {
      const config = {};

      const result = convertGeminiToolConfigToVSCode(config as any);

      assert.strictEqual(result, undefined);
    });
  });

  suite("normalizeSchemaTypes", () => {
    suite("basic type normalization", () => {
      test("should convert uppercase types to lowercase", () => {
        const input = {
          type: "OBJECT",
          properties: {
            location: { type: "STRING" },
            count: { type: "NUMBER" },
            enabled: { type: "BOOLEAN" },
            index: { type: "INTEGER" },
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.properties.location.type, "string");
        assert.strictEqual(result.properties.count.type, "number");
        assert.strictEqual(result.properties.enabled.type, "boolean");
        assert.strictEqual(result.properties.index.type, "integer");
      });

      test("should preserve already lowercase types", () => {
        const input = {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.properties.name.type, "string");
      });

      test("should handle mixed case types", () => {
        const input = {
          type: "Object",
          properties: {
            value: { type: "String" },
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.properties.value.type, "string");
      });

      test("should handle ARRAY and NULL types", () => {
        const input = {
          type: "ARRAY",
          items: { type: "NULL" },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "array");
        assert.strictEqual(result.items.type, "null");
      });

      test("should remove TYPE_UNSPECIFIED", () => {
        const input = {
          type: "TYPE_UNSPECIFIED",
          description: "test",
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, undefined);
        assert.strictEqual(result.description, "test");
      });
    });

    suite("nested schema handling", () => {
      test("should normalize nested properties", () => {
        const input = {
          type: "OBJECT",
          properties: {
            user: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                age: { type: "INTEGER" },
              },
            },
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.properties.user.type, "object");
        assert.strictEqual(
          result.properties.user.properties.name.type,
          "string",
        );
        assert.strictEqual(
          result.properties.user.properties.age.type,
          "integer",
        );
      });

      test("should normalize items in array schema", () => {
        const input = {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              id: { type: "INTEGER" },
            },
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "array");
        assert.strictEqual(result.items.type, "object");
        assert.strictEqual(result.items.properties.id.type, "integer");
      });

      test("should normalize anyOf/oneOf/allOf arrays", () => {
        const input = {
          anyOf: [{ type: "STRING" }, { type: "NUMBER" }],
          oneOf: [{ type: "BOOLEAN" }],
          allOf: [{ type: "OBJECT" }],
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.anyOf[0].type, "string");
        assert.strictEqual(result.anyOf[1].type, "number");
        assert.strictEqual(result.oneOf[0].type, "boolean");
        assert.strictEqual(result.allOf[0].type, "object");
      });
    });

    suite("non-schema fields", () => {
      test("should NOT normalize type in default field", () => {
        const input = {
          type: "OBJECT",
          default: {
            type: "PRODUCTION",
            value: 123,
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.default.type, "PRODUCTION"); // Should NOT be lowercased
      });

      test("should NOT normalize type in example field", () => {
        const input = {
          type: "STRING",
          example: {
            type: "STAGING",
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "string");
        assert.strictEqual(result.example.type, "STAGING"); // Should NOT be lowercased
      });

      test("should NOT normalize type in const field", () => {
        const input = {
          type: "OBJECT",
          const: {
            type: "FIXED_VALUE",
          },
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.const.type, "FIXED_VALUE"); // Should NOT be lowercased
      });

      test("should preserve enum values unchanged", () => {
        const input = {
          type: "STRING",
          enum: ["EAST", "WEST", "NORTH", "SOUTH"],
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "string");
        assert.deepStrictEqual(result.enum, ["EAST", "WEST", "NORTH", "SOUTH"]);
      });
    });

    suite("edge cases", () => {
      test("should handle null input", () => {
        const result = normalizeSchemaTypes(null);
        assert.strictEqual(result, null);
      });

      test("should handle undefined input", () => {
        const result = normalizeSchemaTypes(undefined);
        assert.strictEqual(result, undefined);
      });

      test("should handle primitive inputs", () => {
        assert.strictEqual(normalizeSchemaTypes("string"), "string");
        assert.strictEqual(normalizeSchemaTypes(123), 123);
        assert.strictEqual(normalizeSchemaTypes(true), true);
      });

      test("should handle empty object", () => {
        const result = normalizeSchemaTypes({});
        assert.deepStrictEqual(result, {});
      });

      test("should handle circular references without infinite loop", () => {
        const input: any = {
          type: "OBJECT",
          properties: {},
        };
        input.properties.self = input; // Circular reference

        // Should not throw or hang
        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        // Note: normalizeSchemaTypes returns the original object when a circular
        // reference is detected. This means result.properties.self === input
        // (the original, un-normalized object), not result. This creates a mixed
        // structure, but circular references in JSON Schema are rare in practice.
        assert.strictEqual(result.properties.self, input);
      });

      test("should handle unknown type values by lowercasing", () => {
        const input = {
          type: "CUSTOM_TYPE",
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "custom_type");
      });

      test("should handle deeply nested schemas up to max depth", () => {
        // Create a deeply nested schema (50 levels - within limit)
        let nested: any = { type: "STRING" };
        for (let i = 0; i < 50; i++) {
          nested = { type: "OBJECT", properties: { child: nested } };
        }

        const result = normalizeSchemaTypes(nested) as any;

        // Should normalize the outer type
        assert.strictEqual(result.type, "object");
      });

      test("should not crash when exceeding max depth", () => {
        // Create a schema that exceeds max depth (105 levels > 100 limit)
        let nested: any = { type: "STRING" };
        for (let i = 0; i < 105; i++) {
          nested = { type: "OBJECT", properties: { child: nested } };
        }

        // Should not throw - just returns value as-is after max depth
        const result = normalizeSchemaTypes(nested) as any;

        // Outer levels should still be normalized
        assert.strictEqual(result.type, "object");
        assert.ok(result.properties.child);
      });
    });

    suite("real-world LangChain-style schema", () => {
      test("should normalize LangChain uppercase schema", () => {
        // This is the exact format from the GitHub issue
        const input = {
          type: "OBJECT",
          properties: {
            location: {
              type: "STRING",
              description: "City name",
            },
          },
          required: ["location"],
        };

        const result = normalizeSchemaTypes(input) as any;

        assert.strictEqual(result.type, "object");
        assert.strictEqual(result.properties.location.type, "string");
        assert.strictEqual(result.properties.location.description, "City name");
        assert.deepStrictEqual(result.required, ["location"]);
      });
    });
  });
});
