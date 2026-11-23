import * as assert from "assert";
import * as vscode from "vscode";

import {
  chatModelsCache,
  getChatModelsQuickPickItems,
  normalizeCopilotToolSchema,
  withCopilotConfiguration,
} from "../../utils/chatModels";
import { logger } from "../../utils/logger";

function createMockModel(
  id: string,
  name: string,
  family: string,
): vscode.LanguageModelChat {
  return {
    id,
    name,
    family,
    vendor: "copilot",
    version: "1.0",
    maxInputTokens: 400000,
    countTokens: async () => 1,
    sendRequest: async () => {
      throw new Error("not implemented");
    },
  };
}

suite("Chat Models QuickPick Test Suite", () => {
  const originalGetChatModels = chatModelsCache.getChatModels;

  teardown(() => {
    chatModelsCache.getChatModels = originalGetChatModels;
  });

  test("groups Claude, OpenAI, Gemini, Grok, MAI, and Other in default order", async () => {
    chatModelsCache.getChatModels = async () => [
      createMockModel("copilot-utility", "Utility", "copilot-utility"),
      createMockModel("domain-router", "Domain Router", "domain-router"),
      createMockModel("main-helper", "Main Helper", "main"),
      createMockModel(
        "mai-code-1.1-flash",
        "MAI-Code-1.1-Flash",
        "oswe-vscode-modelD",
      ),
      createMockModel("mai-code-2", "MAI-Code-2.x1 (Preview)", "vscModelF"),
      createMockModel("mai-code-3", "MAI-Code-3", "mai-code-3"),
      createMockModel("grok-4.6", "Grok 4.6", "grok-4.6"),
      createMockModel("grok-4.7", "Grok 4.7", "grok-4.7"),
      createMockModel("gemini-4-carbon", "Gemini 4 Carbon", "gemini-4-carbon"),
      createMockModel("gpt-6.1-sol", "GPT-6.1 Sol", "gpt-6.1-sol"),
      createMockModel(
        "claude-sonnet-4.6",
        "Claude Sonnet 4.6",
        "claude-sonnet-4.6",
      ),
    ];

    const items = await getChatModelsQuickPickItems();
    const separators = items
      .filter(
        (item) =>
          "kind" in item && item.kind === vscode.QuickPickItemKind.Separator,
      )
      .map((item) => item.label);

    assert.deepStrictEqual(separators, [
      "Claude",
      "OpenAI",
      "Gemini",
      "Grok",
      "MAI",
      "Other",
    ]);

    const grokIndex = items.findIndex((item) => item.label === "Grok");
    assert.deepStrictEqual(
      items.slice(grokIndex + 1, grokIndex + 3).map((item) => item.modelId),
      ["grok-4.7", "grok-4.6"],
    );

    const maiIndex = items.findIndex((item) => item.label === "MAI");
    const otherIndex = items.findIndex((item) => item.label === "Other");
    assert.deepStrictEqual(
      items.slice(maiIndex + 1, otherIndex).map((item) => item.modelId),
      ["mai-code-3", "mai-code-2", "mai-code-1.1-flash"],
    );
    assert.deepStrictEqual(
      items.slice(otherIndex + 1).map((item) => item.modelId),
      ["copilot-utility", "main-helper", "domain-router"],
    );
  });

  test("supports prioritizing Grok or MAI while keeping Other last and deduplicating recommended", async () => {
    chatModelsCache.getChatModels = async () => [
      createMockModel("copilot-utility", "Utility", "copilot-utility"),
      createMockModel("gpt-6.1-sol", "GPT-6.1 Sol", "gpt-6.1-sol"),
      createMockModel("grok-4.6", "Grok 4.6", "grok-4.6"),
      createMockModel("grok-4.7", "Grok 4.7", "grok-4.7"),
      createMockModel("mai-code-2", "MAI-Code-2.x1 (Preview)", "vscModelF"),
    ];

    const grokFirst = await getChatModelsQuickPickItems({
      priorityFamily: "grok",
    });
    assert.deepStrictEqual(
      grokFirst
        .filter(
          (item) =>
            "kind" in item && item.kind === vscode.QuickPickItemKind.Separator,
        )
        .map((item) => item.label),
      ["Grok", "OpenAI", "MAI", "Other"],
    );

    const maiFirstWithRecommended = await getChatModelsQuickPickItems({
      priorityFamily: "mai",
      recommendedModelId: "grok-4.7",
    });
    assert.deepStrictEqual(
      maiFirstWithRecommended
        .filter(
          (item) =>
            "kind" in item && item.kind === vscode.QuickPickItemKind.Separator,
        )
        .map((item) => item.label),
      ["Recommended", "MAI", "OpenAI", "Grok", "Other"],
    );
    assert.strictEqual(
      maiFirstWithRecommended.filter((item) => item.modelId === "grok-4.7")
        .length,
      1,
    );
  });

  test("places the auto model in Other regardless of its routed family", async () => {
    chatModelsCache.getChatModels = async () => [
      createMockModel("auto", "Auto", "claude-sonnet-4.6"),
      createMockModel(
        "claude-sonnet-4.6",
        "Claude Sonnet 4.6",
        "claude-sonnet-4.6",
      ),
    ];

    const items = await getChatModelsQuickPickItems();
    const otherIndex = items.findIndex((item) => item.label === "Other");
    assert.deepStrictEqual(
      items.slice(1, otherIndex).map((item) => item.modelId),
      ["claude-sonnet-4.6"],
    );
    assert.deepStrictEqual(
      items.slice(otherIndex + 1).map((item) => item.modelId),
      ["auto"],
    );
  });

  test("rewrites only 400-inducing tool schemas for Copilot Gemini models and logs debug diagnostics", () => {
    const geminiModel = createMockModel(
      "gemini-4-argon",
      "Gemini 4 Argon",
      "gemini-4-argon",
    );
    const gptModel = createMockModel(
      "gpt-6.1-sol",
      "GPT-6.1 Sol",
      "gpt-6.1-sol",
    );

    const cleanSchema = {
      type: "object",
      $defs: {
        Tag: { type: "string" },
      },
      properties: {
        tag: { $ref: "#/$defs/Tag" },
        nullableText: { type: ["string", "null"] },
      },
      additionalProperties: false,
    };

    const rawTools: vscode.LanguageModelChatTool[] = [
      {
        name: "clean_tool",
        description: "Already accepted by Gemini",
        inputSchema: cleanSchema,
      },
      {
        name: "mcp__workiq__retrieve",
        description: "Retrieve M365 grounding",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            capabilities: {
              type: ["array", "null"],
              items: {
                type: ["object", "null"],
                properties: {},
                required: ["name"],
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      include_related_content: { type: ["boolean", "null"] },
                      name: { type: "string", enum: ["People"] },
                    },
                  },
                  {
                    type: "object",
                    properties: {
                      name: { type: "string", enum: ["Meetings"] },
                    },
                  },
                ],
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "mcp__icm__search_incidents",
        description: "Search IcM incidents",
        inputSchema: {
          type: "object",
          properties: {
            severity: {
              type: ["array", "null"],
              enum: [0, 1, 2, 3, 4, 25],
              items: { type: "integer" },
            },
            matrix: {
              type: "array",
              enum: [[1], [2]],
              items: { type: "integer" },
            },
          },
        },
      },
      {
        name: "mcp__etw__add_condition",
        description: "Add ETW condition",
        inputSchema: {
          type: "object",
          properties: {
            value: true,
          },
        },
      },
    ];

    const gptOptions = withCopilotConfiguration(gptModel, { tools: rawTools });
    assert.strictEqual(gptOptions.tools, rawTools);

    const debugLogs: string[] = [];
    const origDebug = logger.debug;
    logger.debug = (...args: unknown[]) => {
      debugLogs.push(args.map(String).join(" "));
    };

    let options: vscode.LanguageModelChatRequestOptions;
    try {
      options = withCopilotConfiguration(geminiModel, { tools: rawTools });
    } finally {
      logger.debug = origDebug;
    }

    assert.strictEqual(options.tools?.[0], rawTools[0]);
    assert.ok(
      debugLogs.some(
        (msg) =>
          msg.includes(
            "Normalized Copilot Gemini tool schema(s) for gemini-4-argon",
          ) &&
          msg.includes("mcp__workiq__retrieve") &&
          msg.includes("mcp__icm__search_incidents") &&
          msg.includes("mcp__etw__add_condition") &&
          !msg.includes("clean_tool"),
      ),
    );

    const retrieveSchema = options.tools?.[1].inputSchema as Record<
      string,
      unknown
    >;
    const capabilities = (
      retrieveSchema.properties as Record<string, Record<string, unknown>>
    ).capabilities;
    assert.deepStrictEqual(capabilities, {
      type: ["array", "null"],
      items: {
        anyOf: [
          {
            type: "object",
            properties: {
              include_related_content: { type: ["boolean", "null"] },
              name: { type: "string", enum: ["People"] },
            },
            required: ["name"],
          },
          {
            type: "object",
            properties: {
              name: { type: "string", enum: ["Meetings"] },
            },
            required: ["name"],
          },
        ],
      },
    });

    const icmSchema = options.tools?.[2].inputSchema as Record<string, unknown>;
    const icmProps = icmSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(icmProps.severity, {
      type: ["array", "null"],
      items: {
        type: "integer",
        enum: [0, 1, 2, 3, 4, 25],
      },
    });
    assert.deepStrictEqual(icmProps.matrix, {
      type: "array",
      items: { type: "integer" },
    });

    const etwSchema = options.tools?.[3].inputSchema as Record<string, unknown>;
    assert.deepStrictEqual(etwSchema, {
      type: "object",
      properties: {
        value: {},
      },
    });
    assert.strictEqual(normalizeCopilotToolSchema(cleanSchema), cleanSchema);
  });

  test("preserves non-empty parent properties in place via allOf and handles union/array edge cases", () => {
    // Non-empty parent `properties` stays in place while `anyOf` and undeclared
    // `required` keys move into `allOf`.
    const withParentProps = {
      type: "object",
      properties: {
        shared: { type: "string" },
      },
      required: ["shared", "mode"],
      additionalProperties: false,
      anyOf: [
        {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["fast"] },
          },
        },
        {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["thorough"] },
          },
        },
      ],
    };
    assert.deepStrictEqual(normalizeCopilotToolSchema(withParentProps), {
      type: "object",
      properties: {
        shared: { type: "string" },
      },
      required: ["shared"],
      additionalProperties: false,
      allOf: [
        { required: ["mode"] },
        {
          anyOf: [
            {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["fast"] },
              },
            },
            {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["thorough"] },
              },
            },
          ],
        },
      ],
    });

    // Untyped union branches inherit the parent type constraint, and
    // array-level enums on non-array schemas remain untouched.
    const untypedBranchesAndObjectEnum = {
      type: "object",
      properties: {
        unionProp: {
          type: "object",
          anyOf: [
            { properties: { a: { type: "string" } } },
            { properties: { b: { type: "number" } } },
          ],
        },
        objectEnum: {
          type: "object",
          enum: [{ mode: "read" }],
        },
        nullableNullOnlyArray: {
          type: ["array", "null"],
          enum: [null],
          items: { type: "integer" },
        },
        itemsAbsentArrayEnum: {
          type: "array",
          enum: ["a", "b"],
        },
        integerParentNumberBranch: {
          type: "integer",
          anyOf: [{ type: "number", minimum: 0 }],
        },
      },
    };
    assert.deepStrictEqual(
      normalizeCopilotToolSchema(untypedBranchesAndObjectEnum),
      {
        type: "object",
        properties: {
          unionProp: {
            anyOf: [
              { type: "object", properties: { a: { type: "string" } } },
              { type: "object", properties: { b: { type: "number" } } },
            ],
          },
          objectEnum: {
            type: "object",
            enum: [{ mode: "read" }],
          },
          nullableNullOnlyArray: {
            type: "null",
            items: { type: "integer" },
          },
          itemsAbsentArrayEnum: {
            type: "array",
            items: {
              enum: ["a", "b"],
            },
          },
          integerParentNumberBranch: {
            anyOf: [{ type: "integer", minimum: 0 }],
          },
        },
      },
    );
  });
});
