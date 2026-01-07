import * as assert from "assert";
import { FunctionCallingConfigMode } from "@google/genai";
import * as vscode from "vscode";

import {
  convertGeminiContentToVSCode,
  convertGeminiContentsToVSCode,
  convertGeminiSystemInstructionToVSCode,
  convertGeminiToolsToVSCode,
  convertGeminiToolConfigToVSCode,
} from "../../server/utils/gemini";

suite("Gemini Conversion Utils Test Suite", () => {
  suite("convertGeminiContentToVSCode", () => {
    test("should convert user role with text part", () => {
      const content = {
        role: "user",
        parts: [{ text: "Hello, how are you?" }],
      };

      const result = convertGeminiContentToVSCode(content);

      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
      );
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

      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
      );
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

      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
      );
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

      assert.strictEqual(
        result.role,
        vscode.LanguageModelChatMessageRole.User,
      );
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
            { name: "func1", description: "First function" },
            { name: "func2", description: "Second function" },
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
          functionDeclarations: [{ name: "func1", description: "First" }],
        },
        {
          functionDeclarations: [{ name: "func2", description: "Second" }],
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
            { name: "valid_func", description: "Valid" },
            { description: "No name" }, // Should be skipped
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
});
