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

  test("normalizes complex MCP tool schemas in withCopilotConfiguration for Gemini models only", () => {
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
    const rawTools: vscode.LanguageModelChatTool[] = [
      {
        name: "mcp__workiq__retrieve",
        description: "Retrieve M365 grounding",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            additionalProperties: {
              type: ["string", "null"],
              default: {
                type: "UPPERCASE_LITERAL",
                additionalProperties: true,
              },
            },
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
          required: ["query", "additionalProperties"],
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
    ];

    const gptOptions = withCopilotConfiguration(gptModel, { tools: rawTools });
    assert.strictEqual(gptOptions.tools, rawTools);

    const options = withCopilotConfiguration(geminiModel, { tools: rawTools });
    const retrieveSchema = options.tools?.[0].inputSchema as Record<
      string,
      unknown
    >;
    const retrieveProps = retrieveSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(retrieveProps.additionalProperties, {
      type: "string",
      default: { type: "UPPERCASE_LITERAL", additionalProperties: true },
    });
    const capabilities = retrieveProps.capabilities;
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
    const icmProps = icmSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.strictEqual(icmProps.severity.type, "array");
    assert.strictEqual(icmProps.severity.enum, undefined);
    assert.deepStrictEqual(icmProps.severity.items, {
      type: "integer",
      enum: [0, 1, 2, 3, 4, 25],
    });
    assert.strictEqual(icmProps.matrix.enum, undefined);
    assert.deepStrictEqual(icmProps.matrix.items, { type: "integer" });
  });

  test("handles recursive $ref unions, root $defs, const discriminators, optional branches, and non-name item unions", () => {
    const normalized = normalizeCopilotToolSchema({
      type: "object",
      $defs: {
        Node: {
          anyOf: [
            {
              type: "object",
              properties: {
                value: { type: "string" },
                next: { $ref: "#/$defs/Node" },
              },
              required: ["value"],
            },
            { type: "null" },
          ],
        },
        CreatePayload: {
          type: "object",
          properties: {
            action: { type: "string", const: "create" },
            title: { type: "string" },
            value: { type: "integer" },
            additionalProperties: {
              type: "string",
              default: { $defs: "keep-literal" },
            },
          },
          required: ["action", "title"],
        },
        UpdatePayload: {
          type: "object",
          properties: {
            action: { type: "string", const: "update" },
            id: { type: "integer" },
            value: { type: "string" },
          },
        },
      },
      properties: {
        tree: { $ref: "#/$defs/Node" },
        payload: {
          anyOf: [
            { $ref: "#/$defs/CreatePayload" },
            { $ref: "#/$defs/UpdatePayload" },
          ],
        },
        events: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "a" },
                  payload: { type: "string" },
                },
                required: ["kind", "payload"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "b" },
                  payload: { type: "string" },
                },
                required: ["kind", "payload"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "c" },
                  payload: { type: "string" },
                },
                required: ["kind", "payload"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "d" },
                  payload: { type: "string" },
                },
                required: ["kind", "payload"],
              },
              {
                type: "object",
                properties: {
                  kind: { type: "string", const: "e" },
                  payload: { type: "string" },
                },
                required: ["kind", "payload"],
              },
            ],
          },
        },
      },
    }) as Record<string, unknown>;

    const props = normalized.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(props.tree, {
      type: "object",
      properties: {
        value: { type: "string" },
        next: { type: "string" },
      },
      required: ["value"],
    });
    assert.deepStrictEqual(props.payload, {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update"] },
        title: { type: "string" },
        value: { type: "string" },
        additionalProperties: {
          type: "string",
          default: { $defs: "keep-literal" },
        },
        id: { type: "integer" },
      },
    });
    assert.deepStrictEqual(props.events, {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["a", "b", "c", "d", "e"] },
          payload: { type: "string" },
        },
        required: ["kind", "payload"],
      },
    });
  });

  test("preserves array item merges, branch-required discriminators, root self-references, $ref siblings, and non-object unions", () => {
    const rootSelfRef = normalizeCopilotToolSchema({
      type: "object",
      properties: {
        label: { type: "string" },
        child: { $ref: "#", description: "Recursive child" },
      },
      required: ["label"],
    });
    assert.deepStrictEqual(rootSelfRef, {
      type: "object",
      properties: {
        label: { type: "string" },
        child: { type: "string", description: "Recursive child" },
      },
      required: ["label"],
    });

    const normalized = normalizeCopilotToolSchema({
      type: "object",
      $defs: {
        BaseFilter: {
          type: "object",
          properties: {
            limit: { type: "integer" },
          },
          required: ["limit"],
        },
        IntA: { type: "integer", const: 1 },
        IntB: { type: "integer", const: 2 },
      },
      properties: {
        mergedUnion: {
          anyOf: [
            {
              type: "object",
              properties: {
                action: { type: "string", const: "first" },
                values: {
                  type: "array",
                  items: { type: "string", enum: ["a"] },
                },
              },
              required: ["action", "values"],
            },
            {
              type: "object",
              properties: {
                action: { type: "string", const: "second" },
                values: {
                  type: "array",
                  items: { type: "string", enum: ["b"] },
                },
              },
              required: ["action", "values"],
            },
          ],
        },
        discriminatedItems: {
          type: "array",
          items: {
            anyOf: ["one", "two", "three", "four", "five"].map((name) => ({
              type: "object",
              properties: {
                name: { type: "string", const: name },
              },
              required: ["name"],
            })),
          },
        },
        refWithSiblings: {
          $ref: "#/$defs/BaseFilter",
          description: "Combined filter",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
        refScalarUnion: {
          description: "Choice of integer constants",
          anyOf: [{ $ref: "#/$defs/IntA" }, { $ref: "#/$defs/IntB" }],
        },
        arrayUnion: {
          description: "Union of string arrays",
          anyOf: [
            {
              type: "array",
              items: { type: "string", enum: ["a"] },
            },
            {
              type: "array",
              items: { type: "string", enum: ["b"] },
            },
          ],
        },
      },
    }) as Record<string, unknown>;

    const props = normalized.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(props.mergedUnion, {
      type: "object",
      properties: {
        action: { type: "string", enum: ["first", "second"] },
        values: {
          type: "array",
          items: { type: "string", enum: ["a", "b"] },
        },
      },
      required: ["action", "values"],
    });
    assert.deepStrictEqual(props.discriminatedItems, {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: ["one", "two", "three", "four", "five"],
          },
        },
        required: ["name"],
      },
    });
    assert.deepStrictEqual(props.refWithSiblings, {
      type: "object",
      description: "Combined filter",
      properties: {
        limit: { type: "integer" },
        query: { type: "string" },
      },
      required: ["limit", "query"],
    });
    assert.deepStrictEqual(props.refScalarUnion, {
      type: "integer",
      description: "Choice of integer constants",
      enum: [1, 2],
    });
    assert.deepStrictEqual(props.arrayUnion, {
      type: "array",
      description: "Union of string arrays",
      items: {
        type: "string",
        enum: ["a", "b"],
      },
    });
  });

  test("handles array JSON pointers, $ref sibling intersection, numeric/scalar union widening, nested branch requireds, and parent-typed unions", () => {
    const normalized = normalizeCopilotToolSchema({
      type: "object",
      $defs: {
        Choice: {
          anyOf: [
            {
              type: "object",
              properties: { target: { type: "string" } },
              required: ["target"],
            },
          ],
        },
        ModeConfig: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["read", "write"] },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["mode"],
        },
        NamedStep: {
          type: "object",
          properties: {
            name: { type: "string", enum: ["s1", "s2", "s3", "s4", "s5"] },
          },
          required: ["name"],
        },
      },
      properties: {
        indexedRef: {
          $ref: "#/$defs/Choice/anyOf/0",
        },
        intersectedRef: {
          $ref: "#/$defs/ModeConfig",
          properties: {
            mode: { type: "string", const: "read" },
            limit: { type: "integer", minimum: 10, maximum: 50 },
          },
          required: ["limit"],
        },
        numericLiteralUnion: {
          anyOf: [{ type: "integer", const: 1 }, { type: "number" }],
        },
        scalarRangeUnion: {
          anyOf: [
            { type: "integer", minimum: 10 },
            { type: "integer", maximum: 0 },
          ],
        },
        nestedRequiredUnion: {
          anyOf: [
            {
              type: "object",
              required: ["name"],
              anyOf: [
                {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    a: { type: "string" },
                  },
                },
                {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    b: { type: "string" },
                  },
                },
              ],
            },
            {
              type: "object",
              properties: {
                name: { type: "string" },
                c: { type: "string" },
              },
              required: ["name"],
            },
          ],
        },
        refSiblingsInItems: {
          type: "array",
          items: {
            anyOf: ["s1", "s2", "s3", "s4", "s5"].map((tag) => ({
              $ref: "#/$defs/NamedStep",
              properties: {
                name: { type: "string", const: tag },
                payload: { type: "string" },
              },
              required: ["payload"],
            })),
          },
        },
        parentTypedEnumUnion: {
          type: "integer",
          description: "Priority level",
          anyOf: [{ enum: [1] }, { enum: [2] }],
        },
      },
    }) as Record<string, unknown>;

    const props = normalized.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(props.indexedRef, {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    });
    assert.deepStrictEqual(props.intersectedRef, {
      type: "object",
      properties: {
        mode: { type: "string", const: "read" },
        limit: { type: "integer", minimum: 10, maximum: 50 },
      },
      required: ["mode", "limit"],
    });
    assert.deepStrictEqual(props.numericLiteralUnion, {
      type: "number",
    });
    assert.deepStrictEqual(props.scalarRangeUnion, {
      type: "integer",
    });
    assert.deepStrictEqual(props.nestedRequiredUnion, {
      type: "object",
      properties: {
        name: { type: "string" },
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
      required: ["name"],
    });
    assert.deepStrictEqual(props.refSiblingsInItems, {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["s1", "s2", "s3", "s4", "s5"] },
          payload: { type: "string" },
        },
        required: ["name", "payload"],
      },
    });
    assert.deepStrictEqual(props.parentTypedEnumUnion, {
      type: "integer",
      description: "Priority level",
      enum: [1, 2],
    });
  });
});
