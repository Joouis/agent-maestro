import * as assert from "assert";
import * as vscode from "vscode";

import {
  chatModelsCache,
  getChatModelsQuickPickItems,
  normalizeCopilotToolSchema,
  withCopilotConfiguration,
} from "../../utils/chatModels";

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

  test("normalizes complex MCP tool schemas in withCopilotConfiguration for Gemini/Copilot compatibility", () => {
    const model = createMockModel(
      "gemini-4-argon",
      "Gemini 4 Argon",
      "gemini-4-argon",
    );
    const options = withCopilotConfiguration(model, {
      tools: [
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
                        name: { type: "string", enum: ["People"] },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        name: { type: "string", enum: ["Meetings"] },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        name: {
                          type: "string",
                          enum: ["OneDriveAndSharePoint"],
                        },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        name: { type: "string", enum: ["Email"] },
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        name: { type: "string", enum: ["TeamsMessages"] },
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
            },
          },
        },
      ],
    });

    const retrieveSchema = options.tools?.[0].inputSchema as Record<
      string,
      unknown
    >;
    const capabilities = (
      retrieveSchema.properties as Record<string, Record<string, unknown>>
    ).capabilities;
    assert.strictEqual(capabilities.type, "array");
    assert.deepStrictEqual(capabilities.items, {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: [
            "People",
            "Meetings",
            "OneDriveAndSharePoint",
            "Email",
            "TeamsMessages",
          ],
        },
      },
      required: ["name"],
    });

    const icmSchema = options.tools?.[1].inputSchema as Record<string, unknown>;
    const severity = (
      icmSchema.properties as Record<string, Record<string, unknown>>
    ).severity;
    assert.strictEqual(severity.type, "array");
    assert.strictEqual(severity.enum, undefined);
    assert.deepStrictEqual(severity.items, {
      type: "integer",
      enum: [0, 1, 2, 3, 4, 25],
    });
    assert.ok(normalizeCopilotToolSchema);
  });
});
