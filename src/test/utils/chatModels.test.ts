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

    const objectEnumSchema = {
      type: "object",
      enum: [{ mode: "read" }],
      properties: {
        mode: { type: "string" },
      },
    };
    assert.strictEqual(
      normalizeCopilotToolSchema(objectEnumSchema),
      objectEnumSchema,
    );

    const unionWithSharedPropsAndClosure = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 3 },
        count: { type: "integer" },
        meta: { enum: [{ a: 1, b: 2 }] },
        refCopy: { $ref: "#/properties/name" },
      },
      dependencies: {
        type: ["name"],
        anyOf: ["count"],
      },
      dependentRequired: {
        type: ["name"],
        anyOf: ["count"],
      },
      unevaluatedProperties: false,
      additionalProperties: false,
      anyOf: [
        {
          properties: {
            name: { enum: ["a", "abcd"] },
            meta: { enum: [{ b: 2, a: 1 }] },
          },
          required: ["name"],
        },
        {
          required: ["count"],
          unevaluatedProperties: false,
        },
      ],
    };
    assert.deepStrictEqual(
      normalizeCopilotToolSchema(unionWithSharedPropsAndClosure),
      {
        $defs: {
          name: { type: "string", minLength: 3 },
        },
        dependencies: {
          type: ["name"],
          anyOf: ["count"],
        },
        dependentRequired: {
          type: ["name"],
          anyOf: ["count"],
        },
        unevaluatedProperties: false,
        anyOf: [
          {
            type: "object",
            properties: {
              name: { type: "string", minLength: 3, enum: ["a", "abcd"] },
              count: { type: "integer" },
              meta: { enum: [{ a: 1, b: 2 }] },
              refCopy: { $ref: "#/$defs/name" },
            },
            required: ["name"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              name: { type: "string", minLength: 3 },
              count: { type: "integer" },
              meta: { enum: [{ a: 1, b: 2 }] },
              refCopy: { $ref: "#/$defs/name" },
            },
            required: ["count"],
            additionalProperties: false,
            allOf: [
              {
                required: ["count"],
                unevaluatedProperties: false,
              },
            ],
          },
        ],
      },
    );

    const arrayEnumWithUnion = {
      type: "array",
      enum: [1, 2],
      items: { type: "integer" },
      anyOf: [{ minItems: 1 }],
    };
    assert.deepStrictEqual(normalizeCopilotToolSchema(arrayEnumWithUnion), {
      items: { type: "integer", enum: [1, 2] },
      anyOf: [{ type: "array", minItems: 1 }],
    });

    const refScopeAndAnchorSchema = {
      type: "object",
      properties: {
        "a b": { $anchor: "AnchorA", type: "string" },
        encodedRef: { $ref: "#/properties/a%20b" },
        anchorRef: { $ref: "#AnchorA" },
        blocked: {
          type: "object",
          anyOf: [{ type: "string" }],
        },
        blockedRef: { $ref: "#/properties/blocked/anyOf/0" },
        nestedResource: {
          $id: "https://example.com/nested.json",
          type: "object",
          properties: {
            "a b": { type: "number" },
            localRef: { $ref: "#/properties/a%20b" },
          },
        },
      },
      anyOf: [
        {
          properties: {
            "a b": { minLength: 3 },
          },
        },
      ],
    };
    assert.deepStrictEqual(
      normalizeCopilotToolSchema(refScopeAndAnchorSchema),
      {
        $defs: {
          "a b": { $anchor: "AnchorA", type: "string" },
          blocked: {
            type: "object",
            anyOf: [{ type: "string" }],
          },
        },
        anyOf: [
          {
            type: "object",
            properties: {
              "a b": { type: "string", minLength: 3 },
              encodedRef: { $ref: "#/$defs/a%20b" },
              anchorRef: { $ref: "#AnchorA" },
              blocked: {
                type: "object",
                anyOf: [{ type: "string" }],
              },
              blockedRef: { $ref: "#/$defs/blocked/anyOf/0" },
              nestedResource: {
                $id: "https://example.com/nested.json",
                type: "object",
                properties: {
                  "a b": { type: "number" },
                  localRef: { $ref: "#/properties/a%20b" },
                },
              },
            },
          },
        ],
      },
    );

    const round6Schema = {
      type: "object",
      required: ["name"],
      properties: {
        a: { minimum: 0, exclusiveMinimum: true },
        encodedSlashRef: { $ref: "#/properties%2Fa" },
        embeddedRef: { $ref: "https://example.com/value" },
      },
      anyOf: [
        {
          $id: "https://example.com/value",
          type: "string",
        },
        {
          $ref: "#/$defs/B",
          type: "string",
          properties: {
            a: { minimum: 1 },
          },
        },
        {
          properties: {
            a: { minimum: 1 },
          },
        },
      ],
      $defs: {
        B: { type: "object" },
      },
    };
    assert.deepStrictEqual(normalizeCopilotToolSchema(round6Schema), {
      $defs: {
        B: { type: "object" },
        anyOf_0: {
          $id: "https://example.com/value",
          type: "string",
        },
        a: { minimum: 0, exclusiveMinimum: true },
      },
      anyOf: [
        {
          type: "object",
          required: ["name"],
          properties: {
            a: { minimum: 0, exclusiveMinimum: true },
            encodedSlashRef: { $ref: "#/$defs/a" },
            embeddedRef: { $ref: "https://example.com/value" },
          },
          allOf: [
            {
              $ref: "#/$defs/B",
              type: "string",
              properties: {
                a: { minimum: 1 },
              },
            },
          ],
        },
        {
          type: "object",
          required: ["name"],
          properties: {
            a: {
              allOf: [{ minimum: 0, exclusiveMinimum: true }, { minimum: 1 }],
            },
            encodedSlashRef: { $ref: "#/$defs/a" },
            embeddedRef: { $ref: "https://example.com/value" },
          },
        },
      ],
    });
  });

  test("preserves Draft-07 property $refs, legacy #fragment id anchors, unevaluatedProperties vs parent additionalProperties, outer pointer aliases across $id, and stripped-resource relative refs", () => {
    const round7Schema = {
      type: "object",
      $defs: {
        BaseProp: { type: "string", minLength: 1 },
      },
      properties: {
        refProp: {
          $ref: "#/$defs/BaseProp",
          id: "#LegacyPropAnchor",
        },
        legacyRefUser: { $ref: "#LegacyPropAnchor" },
        outerPointerUser: {
          $ref: "#/properties/nestedIdUnion/properties/innerA",
        },
        rootSelfRefUser: { $ref: "#/anyOf/1" },
        nestedIdUnion: {
          $id: "https://example.com/nested",
          type: "object",
          properties: {
            innerA: { type: "string" },
          },
          anyOf: [
            {
              properties: {
                innerB: { type: "number" },
              },
            },
          ],
        },
      },
      additionalProperties: { type: "string" },
      anyOf: [
        false,
        {
          properties: {
            refProp: { maxLength: 10 },
            selfRoot: { $ref: "#" },
          },
          unevaluatedProperties: false,
        },
        {
          $id: "https://example.com/branch-resource",
          $defs: {
            Val: { type: "string" },
          },
          properties: {
            v: { $ref: "#/$defs/Val" },
          },
        },
      ],
    };

    assert.deepStrictEqual(normalizeCopilotToolSchema(round7Schema), {
      $defs: {
        BaseProp: { type: "string", minLength: 1 },
        anyOf_1: {
          properties: {
            refProp: { maxLength: 10 },
            selfRoot: { $ref: "#" },
          },
          unevaluatedProperties: false,
        },
        refProp: {
          $ref: "#/$defs/BaseProp",
          id: "#LegacyPropAnchor",
        },
        nestedIdUnion: {
          $id: "https://example.com/nested",
          $defs: {
            innerA: { type: "string" },
          },
          anyOf: [
            {
              type: "object",
              properties: {
                innerA: { type: "string" },
                innerB: { type: "number" },
              },
            },
          ],
        },
      },
      anyOf: [
        {
          type: "object",
          properties: {
            refProp: {
              allOf: [{ $ref: "#/$defs/BaseProp" }, { maxLength: 10 }],
            },
            legacyRefUser: { $ref: "#LegacyPropAnchor" },
            outerPointerUser: {
              $ref: "#/$defs/nestedIdUnion/$defs/innerA",
            },
            rootSelfRefUser: { $ref: "#/$defs/anyOf_1" },
            nestedIdUnion: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    innerA: { type: "string" },
                    innerB: { type: "number" },
                  },
                },
              ],
            },
            selfRoot: {
              allOf: [{ type: "string" }, { $ref: "#" }],
            },
          },
          additionalProperties: { type: "string" },
          allOf: [
            {
              properties: {
                refProp: { maxLength: 10 },
                selfRoot: { $ref: "#" },
              },
              unevaluatedProperties: false,
            },
          ],
        },
        {
          type: "object",
          properties: {
            refProp: { $ref: "#/$defs/BaseProp" },
            legacyRefUser: { $ref: "#LegacyPropAnchor" },
            outerPointerUser: {
              $ref: "#/$defs/nestedIdUnion/$defs/innerA",
            },
            rootSelfRefUser: { $ref: "#/$defs/anyOf_1" },
            nestedIdUnion: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    innerA: { type: "string" },
                    innerB: { type: "number" },
                  },
                },
              ],
            },
          },
          additionalProperties: { type: "string" },
          allOf: [
            {
              $id: "https://example.com/branch-resource",
              $defs: {
                Val: { type: "string" },
              },
              properties: {
                v: { $ref: "#/$defs/Val" },
              },
            },
          ],
        },
      ],
    });
  });

  test("rebases stripped-resource descendant refs to stable hoisted $defs target even after filtered branches", () => {
    const strippedResourceSchema = {
      type: "object",
      properties: {
        extUser: { $ref: "https://example.com/branch-res#/$defs/Val" },
      },
      anyOf: [
        false,
        {
          $id: "https://example.com/branch-res",
          $defs: {
            Val: { type: "string" },
          },
          properties: {
            v: { $ref: "#/$defs/Val" },
            selfRoot: { $ref: "#" },
          },
        },
      ],
    };

    assert.deepStrictEqual(normalizeCopilotToolSchema(strippedResourceSchema), {
      $defs: {
        anyOf_1: {
          $id: "https://example.com/branch-res",
          $defs: {
            Val: { type: "string" },
          },
          properties: {
            v: { $ref: "#/$defs/Val" },
            selfRoot: { $ref: "#" },
          },
        },
      },
      anyOf: [
        {
          type: "object",
          properties: {
            extUser: { $ref: "https://example.com/branch-res#/$defs/Val" },
          },
          allOf: [
            {
              $defs: {
                Val: { type: "string" },
              },
              properties: {
                v: { $ref: "#/$defs/anyOf_1/$defs/Val" },
                selfRoot: { $ref: "#/$defs/anyOf_1" },
              },
            },
          ],
        },
      ],
    });
  });

  test("isolates patternProperties closures without RegExp evaluation, returns false on disjoint enums, deduplicates unreferenced distributed anchors, and isolates equal relative $id strings", () => {
    const round8Schema = {
      $id: "nested/",
      type: "object",
      properties: {
        a: { $anchor: "UnrefA", enum: ["x"] },
      },
      patternProperties: {
        "^(a+)+$": { type: "string" },
      },
      additionalProperties: false,
      anyOf: [
        {
          properties: {
            a: { enum: ["y"] },
            b: { type: "number" },
          },
        },
        {
          $id: "nested/",
          properties: {
            c: { type: "boolean" },
          },
        },
      ],
    };

    assert.deepStrictEqual(normalizeCopilotToolSchema(round8Schema), {
      $id: "nested/",
      $defs: {
        a: { $anchor: "UnrefA", enum: ["x"] },
      },
      anyOf: [
        {
          type: "object",
          properties: {
            a: false,
            b: { type: "number" },
          },
          patternProperties: {
            "^(a+)+$": { type: "string" },
          },
          allOf: [
            {
              properties: {
                a: { enum: ["x"] },
              },
              patternProperties: {
                "^(a+)+$": { type: "string" },
              },
              additionalProperties: false,
            },
          ],
        },
        {
          type: "object",
          properties: {
            a: { enum: ["x"] },
          },
          patternProperties: {
            "^(a+)+$": { type: "string" },
          },
          additionalProperties: false,
          allOf: [
            {
              $id: "nested/",
              properties: {
                c: { type: "boolean" },
              },
            },
          ],
        },
      ],
    });

    const round9Schema = {
      type: "object",
      properties: {
        p: {
          $id: "sub/p.json",
          type: "object",
          $anchor: "PAnchor",
          properties: {
            ext: { $ref: "q.json#QVal" },
            anchorSelf: { $ref: "#PAnchor" },
          },
        },
      },
      patternProperties: {
        "^x_": { $anchor: "PatternAnchor", type: "string" },
      },
      additionalProperties: false,
      anyOf: [
        {
          properties: {
            b: { $anchor: "BranchPropAnchor", type: "number" },
          },
          unevaluatedProperties: false,
        },
      ],
    };

    assert.deepStrictEqual(normalizeCopilotToolSchema(round9Schema), {
      $defs: {
        anyOf_0: {
          properties: {
            b: { $anchor: "BranchPropAnchor", type: "number" },
          },
          unevaluatedProperties: false,
        },
        p: {
          $id: "sub/p.json",
          type: "object",
          $anchor: "PAnchor",
          properties: {
            ext: { $ref: "q.json#QVal" },
            anchorSelf: { $ref: "#PAnchor" },
          },
        },
        "^x_": { $anchor: "PatternAnchor", type: "string" },
      },
      anyOf: [
        {
          type: "object",
          properties: {
            p: {
              type: "object",
              properties: {
                ext: { $ref: "sub/q.json#QVal" },
                anchorSelf: { $ref: "sub/p.json#PAnchor" },
              },
            },
            b: { type: "number" },
          },
          patternProperties: {
            "^x_": { type: "string" },
          },
          allOf: [
            {
              properties: {
                p: {
                  type: "object",
                  properties: {
                    ext: { $ref: "sub/q.json#QVal" },
                    anchorSelf: { $ref: "sub/p.json#PAnchor" },
                  },
                },
              },
              patternProperties: {
                "^x_": { type: "string" },
              },
              additionalProperties: false,
            },
            {
              properties: {
                b: { type: "number" },
              },
              unevaluatedProperties: false,
            },
          ],
        },
      ],
    });

    // Round 10:
    // 1. Recursive nested union subtrees are hoisted once into $defs and shared
    //    via $ref instead of expanding 2^N times, and schemas exceeding the
    //    expansion budget fall back cleanly without hanging.
    let deepUnion: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 25; depth++) {
      deepUnion = {
        type: "object",
        properties: { child: deepUnion },
        anyOf: [{ required: ["child"] }, { additionalProperties: true }],
      };
    }
    const startMs = Date.now();
    const normalizedDeep = normalizeCopilotToolSchema(deepUnion) as Record<
      string,
      unknown
    >;
    assert.ok(Date.now() - startMs < 1000);
    assert.ok(typeof normalizedDeep.$defs === "object");

    // 2. Same-resource legacy URI#fragment id preserves enclosing pointer;
    // 3. Colon-prefixed relative refs preserve "./";
    // 4. Nested hoisting rewrites references to the canonical hoisted branch ($defs.a, not $defs.a_1).
    const round10Schema = {
      $id: "https://example.com/root.json",
      type: "object",
      properties: {
        child: {
          id: "https://example.com/root.json#child",
          type: "object",
          properties: {
            a: { type: "string" },
          },
          anyOf: [{ required: ["a"] }],
        },
        refToChildA: {
          $ref: "#/properties/child/properties/a",
        },
        x: {
          type: "object",
          $defs: {
            a: { type: "number" },
          },
          properties: {
            b: { type: "boolean" },
          },
        },
        refToBranchXA: {
          $ref: "#/anyOf/0/properties/x/properties/a",
        },
      },
      anyOf: [
        {
          properties: {
            x: {
              type: "object",
              properties: {
                a: { type: "string" },
              },
              anyOf: [{ required: ["a"] }],
            },
          },
        },
        {
          properties: {
            colonProp: {
              $id: "p.json",
              type: "object",
              properties: {
                target: { $ref: "./q:value.json" },
              },
            },
          },
        },
      ],
    };

    const normalizedRound10 = normalizeCopilotToolSchema(round10Schema) as {
      $defs: Record<string, unknown>;
      anyOf: Array<Record<string, unknown>>;
    };
    const branch0Props = normalizedRound10.anyOf[0].properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.strictEqual(branch0Props.refToChildA.$ref, "#/$defs/child/$defs/a");
    assert.strictEqual(
      branch0Props.refToBranchXA.$ref,
      "#/$defs/anyOf_0/properties/x/$defs/a",
    );

    const noRootColonSchema = {
      type: "object",
      properties: {
        p: {
          $id: "p.json",
          type: "object",
          properties: {
            v: { $ref: "./q:value.json" },
          },
        },
      },
      anyOf: [{ required: ["p"] }, { additionalProperties: false }],
    };
    const normalizedColon = normalizeCopilotToolSchema(noRootColonSchema) as {
      anyOf: Array<{
        properties: { p: { properties: { v: { $ref: string } } } };
      }>;
    };
    assert.strictEqual(
      normalizedColon.anyOf[0].properties.p.properties.v.$ref,
      "./q:value.json",
    );

    // Round 11:
    // 1. Nested union sharing inside hoisted subtrees rewrites generated $ref
    //    pointers to the hoisted destination (#/$defs/child/$defs/child)
    //    rather than the removed original path (#/properties/child/$defs/child).
    const topDefs = normalizedDeep.$defs as Record<
      string,
      Record<string, unknown>
    >;
    const firstHoistedChild = topDefs.child;
    const firstHoistedBranch0Props = (
      (firstHoistedChild.anyOf as Array<Record<string, unknown>>)[0]
        .properties as Record<string, Record<string, unknown>>
    ).child;
    assert.strictEqual(
      firstHoistedBranch0Props.$ref,
      "#/$defs/child/$defs/child",
    );

    // 2. Nested union branches and union-bearing merged properties never emit
    //    type/properties/required alongside anyOf/oneOf.
    const nestedUnionSchema = {
      type: "object",
      properties: {
        shared: {
          type: "object",
          properties: {
            a: { type: "string" },
          },
        },
      },
      anyOf: [
        {
          anyOf: [{ required: ["shared"] }],
        },
        {
          properties: {
            shared: {
              anyOf: [{ required: ["a"] }],
            },
          },
        },
      ],
    };
    const normalizedNestedUnion = normalizeCopilotToolSchema(
      nestedUnionSchema,
    ) as {
      anyOf: Array<Record<string, unknown>>;
    };
    assert.strictEqual(normalizedNestedUnion.anyOf[0].type, "object");
    assert.strictEqual(normalizedNestedUnion.anyOf[0].anyOf, undefined);
    assert.ok(Array.isArray(normalizedNestedUnion.anyOf[0].allOf));
    const branch1Shared = (
      normalizedNestedUnion.anyOf[1].properties as Record<
        string,
        Record<string, unknown>
      >
    ).shared;
    assert.strictEqual(branch1Shared.type, undefined);
    assert.strictEqual(branch1Shared.anyOf, undefined);
    assert.ok(Array.isArray(branch1Shared.allOf));

    // Round 12:
    // 1. Same-resource fragment ID with a root-relative descendant reference
    //    preserves #/$defs/V instead of rebasing to #/$defs/child/$defs/V;
    // 2. URI-qualified same-resource legacy fragment anchor on a union branch
    //    is hoisted to $defs before parent constraints are distributed;
    // 3. Wrapped nested union property (array items containing two levels of
    //    nested unions) hoists the wrapper and rewrites generated descendant
    //    references to #/$defs/wrapped/items/$defs/child;
    // 4. Union node without sibling type, properties, or required (e.g. only
    //    additionalProperties: false) remains untouched.
    const round12Schema = {
      id: "https://example.com/root.json",
      type: "object",
      $defs: {
        V: { type: "string" },
      },
      properties: {
        child: {
          id: "https://example.com/root.json#child",
          type: "object",
          properties: {
            v: { $ref: "#/$defs/V" },
          },
        },
        value: {
          $ref: "#Branch",
        },
        wrapped: {
          type: "array",
          items: {
            type: "object",
            properties: {
              child: {
                type: "object",
                properties: {
                  leaf: { type: "string" },
                },
                anyOf: [{ required: ["leaf"] }, { additionalProperties: true }],
              },
            },
            anyOf: [{ required: ["child"] }, { additionalProperties: true }],
          },
        },
        untouchedUnion: {
          anyOf: [{}],
          additionalProperties: false,
        },
      },
      anyOf: [
        {
          id: "https://example.com/root.json#Branch",
        },
        {
          required: ["child", "wrapped"],
        },
      ],
    };

    const normalizedRound12 = normalizeCopilotToolSchema(round12Schema) as {
      $defs: Record<string, Record<string, unknown>>;
      anyOf: Array<Record<string, unknown>>;
    };
    assert.deepStrictEqual(normalizedRound12.$defs.anyOf_0, {
      id: "https://example.com/root.json#Branch",
    });
    assert.strictEqual(normalizedRound12.anyOf[0].id, undefined);
    const r12Branch0Props = normalizedRound12.anyOf[0].properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.strictEqual(
      (
        r12Branch0Props.child.properties as Record<
          string,
          Record<string, unknown>
        >
      ).v.$ref,
      "#/$defs/V",
    );
    assert.deepStrictEqual(r12Branch0Props.wrapped, {
      $ref: "#/$defs/wrapped",
    });
    const wrappedItemsBranch0 = (
      (normalizedRound12.$defs.wrapped.items as Record<string, unknown>)
        .anyOf as Array<Record<string, unknown>>
    )[0];
    assert.strictEqual(
      (
        wrappedItemsBranch0.properties as Record<
          string,
          Record<string, unknown>
        >
      ).child.$ref,
      "#/$defs/wrapped/items/$defs/child",
    );
    assert.strictEqual(typeof normalizedRound12.$defs.wrapped, "object");
    assert.deepStrictEqual(r12Branch0Props.untouchedUnion, {
      anyOf: [{}],
      additionalProperties: false,
    });

    const round13EmptyUnionSchema = {
      type: "object",
      properties: {
        impossible: {
          type: "object",
          properties: {
            nested: {
              $id: "https://example.com/nested-id.json",
              type: "array",
              enum: ["a", "b"],
              items: { type: "string" },
            },
            refNestedEnum: {
              $ref: "#/properties/impossible/properties/nested/enum",
            },
          },
          anyOf: [{ type: "string" }],
        },
        singleSurvivor: {
          type: "object",
          properties: {
            sub: {
              $id: "https://example.com/sub-id.json",
              type: "string",
            },
          },
          anyOf: [{ type: "string" }, { required: ["sub"] }],
        },
        relocatedUnion: {
          type: "array",
          anyOf: [{ enum: ["x", "y"], items: { type: "string" } }],
        },
        relocatedMergedProp: {
          type: "object",
          properties: {
            tags: { type: "array", items: { type: "string" } },
          },
          anyOf: [
            {
              properties: {
                tags: { enum: ["p", "q"] },
              },
            },
          ],
        },
      },
      anyOf: [
        {
          required: ["impossible"],
          properties: {
            refEnum: {
              $ref: "#/properties/relocatedUnion/anyOf/0/enum",
            },
          },
        },
      ],
    };

    const normalizedRound13 = normalizeCopilotToolSchema(
      round13EmptyUnionSchema,
    ) as {
      $defs: Record<string, Record<string, unknown>>;
      anyOf: Array<Record<string, unknown>>;
    };
    const r13Branch0Props = normalizedRound13.anyOf[0].properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepStrictEqual(r13Branch0Props.impossible.anyOf, [
      { type: "string" },
    ]);
    const impossibleProps = r13Branch0Props.impossible.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.strictEqual(r13Branch0Props.impossible.$defs, undefined);
    const impossibleDefsProps = (
      normalizedRound13.$defs.impossible as Record<string, unknown>
    ).properties as Record<string, Record<string, unknown>>;
    assert.strictEqual(
      impossibleDefsProps.nested.$id,
      "https://example.com/nested-id.json",
    );
    assert.deepStrictEqual(impossibleProps.nested.items, {
      type: "string",
      enum: ["a", "b"],
    });
    assert.strictEqual(
      impossibleProps.refNestedEnum.$ref,
      "#/$defs/impossible/properties/nested/items/enum",
    );
    const singleSurvivorBranch0 = (
      r13Branch0Props.singleSurvivor.anyOf as Array<Record<string, unknown>>
    )[0];
    assert.strictEqual(
      (
        (singleSurvivorBranch0.properties as Record<string, unknown>)
          .sub as Record<string, unknown>
      ).$id,
      "https://example.com/sub-id.json",
    );
    const relocatedUnionBranch0 = (
      r13Branch0Props.relocatedUnion.anyOf as Array<Record<string, unknown>>
    )[0];
    assert.strictEqual(relocatedUnionBranch0.enum, undefined);
    assert.deepStrictEqual(relocatedUnionBranch0.items, {
      type: "string",
      enum: ["x", "y"],
    });
    assert.strictEqual(
      r13Branch0Props.refEnum.$ref,
      "#/$defs/relocatedUnion/$defs/anyOf_0/items/enum",
    );
    const mergedTagsProp = (
      (
        r13Branch0Props.relocatedMergedProp.anyOf as Array<
          Record<string, unknown>
        >
      )[0].properties as Record<string, unknown>
    ).tags as Record<string, unknown>;
    assert.strictEqual(mergedTagsProp.enum, undefined);
    assert.deepStrictEqual(mergedTagsProp.items, {
      type: "string",
      enum: ["p", "q"],
    });

    // Round 14: nested overlapping object properties inside union distribution
    // must preserve both parent and branch reference scopes without throwing,
    // and union branches relocating array-level enum via parent `items` must
    // not copy raw unnormalized `node.items` into branches.
    const round14EdgeCases = {
      type: "object",
      properties: {
        nestedMerge: {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                tags: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
          },
          anyOf: [
            {
              properties: {
                config: {
                  type: "object",
                  properties: {
                    tags: {
                      enum: ["alpha", "beta"],
                    },
                  },
                },
              },
            },
            { required: ["config"] },
          ],
        },
        refNestedBranchEnum: {
          $ref: "#/properties/nestedMerge/anyOf/0/properties/config/properties/tags/enum",
        },
        inheritedItemsUnion: {
          type: "array",
          items: {
            $id: "https://example.com/item-id.json",
            type: "string",
            anyOf: [{ minLength: 1 }],
          },
          anyOf: [{ enum: ["a", "b"] }],
        },
      },
    };
    const normalizedRound14 = normalizeCopilotToolSchema(round14EdgeCases) as {
      properties: Record<string, Record<string, unknown>>;
    };
    const nestedMergeBranch0 = (
      normalizedRound14.properties.nestedMerge.anyOf as Array<
        Record<string, unknown>
      >
    )[0];
    const nestedConfigTags = (
      (nestedMergeBranch0.properties as Record<string, Record<string, unknown>>)
        .config.properties as Record<string, Record<string, unknown>>
    ).tags;
    assert.strictEqual(nestedConfigTags.enum, undefined);
    assert.deepStrictEqual(nestedConfigTags.items, {
      type: "string",
      enum: ["alpha", "beta"],
    });
    assert.strictEqual(
      normalizedRound14.properties.refNestedBranchEnum.$ref,
      "#/properties/nestedMerge/$defs/anyOf_0/properties/config/properties/tags/items/enum",
    );
    const inheritedItemsSchema = normalizedRound14.properties
      .inheritedItemsUnion as Record<string, unknown>;
    assert.deepStrictEqual(inheritedItemsSchema.items, {
      $id: "https://example.com/item-id.json",
      anyOf: [{ type: "string", minLength: 1 }],
    });
    const inheritedUnionBranch0 = (
      inheritedItemsSchema.anyOf as Array<Record<string, unknown>>
    )[0];
    assert.strictEqual(inheritedUnionBranch0.enum, undefined);
    assert.deepStrictEqual(inheritedUnionBranch0.items, {
      enum: ["a", "b"],
    });

    // Round 15: share duplicated array-wrapped unions via `$defs` to prevent
    // exponential output growth, rebase nested resource `$ref`s after inner
    // normalization rewrites, and intersect own + inherited item types when
    // checking array-level enum compatibility.
    const round15EdgeCases = {
      type: "object",
      properties: {
        sharedArrayUnion: {
          type: "object",
          properties: {
            arr: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  leaf: { type: "string" },
                },
                anyOf: [{ required: ["leaf"] }, { minProperties: 1 }],
              },
            },
          },
          anyOf: [{ required: ["arr"] }, { minProperties: 1 }],
        },
        rebasedNestedResource: {
          type: "object",
          properties: {
            p: {
              $id: "https://example.com/p.json",
              type: "object",
              properties: {
                a: {
                  type: "object",
                  properties: { x: { type: "string" } },
                  anyOf: [{ required: ["x"] }, { minProperties: 1 }],
                },
                b: {
                  $ref: "#/properties/a",
                },
              },
              anyOf: [{ required: ["a"] }, { required: ["b"] }],
            },
          },
          anyOf: [{ required: ["p"] }, { minProperties: 1 }],
        },
        incompatibleInheritedItems: {
          type: "array",
          items: { type: "integer" },
          anyOf: [{ items: {}, enum: ["a"] }],
        },
      },
    };
    const normalizedRound15 = normalizeCopilotToolSchema(round15EdgeCases) as {
      properties: Record<string, Record<string, unknown>>;
    };
    const sharedArrayUnion = normalizedRound15.properties.sharedArrayUnion as {
      $defs: Record<string, unknown>;
      anyOf: Array<Record<string, unknown>>;
    };
    assert.ok(sharedArrayUnion.$defs.arr);
    assert.deepStrictEqual(
      (sharedArrayUnion.anyOf[0].properties as Record<string, unknown>).arr,
      { $ref: "#/properties/sharedArrayUnion/$defs/arr" },
    );
    const rebasedPBranch0 = (
      (
        (
          normalizedRound15.properties.rebasedNestedResource.anyOf as Array<
            Record<string, unknown>
          >
        )[0].properties as Record<string, Record<string, unknown>>
      ).p.anyOf as Array<Record<string, unknown>>
    )[0];
    assert.strictEqual(
      (
        (rebasedPBranch0.properties as Record<string, Record<string, unknown>>)
          .b as Record<string, unknown>
      ).$ref,
      "#/properties/rebasedNestedResource/$defs/p/$defs/a",
    );
    const incompatibleBranch0 = (
      normalizedRound15.properties.incompatibleInheritedItems.anyOf as Array<
        Record<string, unknown>
      >
    )[0];
    assert.strictEqual(incompatibleBranch0.enum, undefined);
    assert.deepStrictEqual(incompatibleBranch0.items, {});

    // Round 16:
    // 1. Nested unions containing `$ref` (or generated `$ref`s) still share via
    //    `$defs`, and duplicated identifier-bearing subtrees charge the node
    //    budget for every emitted copy.
    // 2. Null-only array-level `enum: [null]` on `type: ["array", "null"]`
    //    narrows to `type: "null"`.
    // 3. Array-level scalar `enum` without an `items` keyword still relocates
    //    to `items.enum`.
    const round16EdgeCases = {
      type: "object",
      $defs: {
        SharedStr: { type: "string" },
      },
      properties: {
        refBearingUnion: {
          type: "object",
          properties: {
            nestedUnionWithRef: {
              type: "object",
              properties: {
                s: { $ref: "#/$defs/SharedStr" },
              },
              anyOf: [{ required: ["s"] }, { minProperties: 1 }],
            },
          },
          anyOf: [{ required: ["nestedUnionWithRef"] }, { minProperties: 1 }],
        },
        nullableArrayNullBranch: {
          type: ["array", "null"],
          anyOf: [
            { type: "array", items: { type: "integer" } },
            { enum: [null] },
          ],
        },
        untypedArrayEnum: {
          type: "array",
          enum: ["a", "b"],
        },
      },
    };
    const normalizedRound16 = normalizeCopilotToolSchema(round16EdgeCases) as {
      properties: Record<string, Record<string, unknown>>;
    };
    const refBearingUnion = normalizedRound16.properties.refBearingUnion as {
      $defs: Record<string, unknown>;
      anyOf: Array<Record<string, unknown>>;
    };
    assert.ok(refBearingUnion.$defs.nestedUnionWithRef);
    assert.deepStrictEqual(
      (refBearingUnion.anyOf[0].properties as Record<string, unknown>)
        .nestedUnionWithRef,
      { $ref: "#/properties/refBearingUnion/$defs/nestedUnionWithRef" },
    );
    assert.deepStrictEqual(
      normalizedRound16.properties.nullableArrayNullBranch,
      {
        anyOf: [
          { type: "array", items: { type: "integer" } },
          { type: "null" },
        ],
      },
    );
    assert.deepStrictEqual(normalizedRound16.properties.untypedArrayEnum, {
      type: "array",
      items: {
        enum: ["a", "b"],
      },
    });

    let deepIdentifiedUnion: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 20; depth++) {
      deepIdentifiedUnion = {
        $id: `https://example.com/level-${depth}.json`,
        type: "object",
        properties: { child: deepIdentifiedUnion },
        anyOf: [{ required: ["child"] }, { minProperties: 1 }],
      };
    }
    const idUnionStartMs = Date.now();
    const normalizedDeepIdentified =
      normalizeCopilotToolSchema(deepIdentifiedUnion);
    assert.ok(Date.now() - idUnionStartMs < 1000);
    assert.deepStrictEqual(normalizedDeepIdentified, deepIdentifiedUnion);
  });
});
