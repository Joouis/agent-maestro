import * as vscode from "vscode";

import { readConfiguration } from "./config";
import { logger } from "./logger";

const SUPPORTED_VENDOR = "copilot";
const warnedUnavailableFallbackModelIds = new Set<string>();

async function selectSupportedModels(): Promise<vscode.LanguageModelChat[]> {
  const allModels = await vscode.lm.selectChatModels();
  const supported = allModels.filter((m) => m.vendor === SUPPORTED_VENDOR);

  const col = (s: string, w: number) =>
    s.length > w ? s.slice(0, w - 3) + "..." : s.padEnd(w);
  const colW = { proxy: 6, name: 36, id: 28, vendor: 15, tokens: 15 };
  const header = `  ${col("Proxy", colW.proxy)} ${col("Name", colW.name)} ${col("ID", colW.id)} ${col("Vendor", colW.vendor)} ${col("MaxInputTokens", colW.tokens)}`;
  const divider = `  ${"-".repeat(colW.proxy)} ${"-".repeat(colW.name)} ${"-".repeat(colW.id)} ${"-".repeat(colW.vendor)} ${"-".repeat(colW.tokens)}`;
  const rows = allModels.map((m) => {
    const eligible = m.vendor === SUPPORTED_VENDOR;
    return `  ${col(`[${eligible ? "x" : " "}]`, colW.proxy)} ${col(m.name, colW.name)} ${col(m.id, colW.id)} ${col(m.vendor, colW.vendor)} ${m.maxInputTokens}`;
  });
  logger.info(
    `Available models (${allModels.length} total, ${supported.length} proxy-eligible):\n` +
      [header, divider, ...rows].join("\n"),
  );

  return supported;
}

interface ChatModelsInitializationResult {
  models: vscode.LanguageModelChat[];
  error?: Error;
}

class ChatModelsCache {
  private static instance: ChatModelsCache;
  private cachedModels: vscode.LanguageModelChat[] = [];
  private initializationPromise: Promise<ChatModelsInitializationResult> | null =
    null;
  private initializationRunId = 0;

  private constructor() {}

  static getInstance(): ChatModelsCache {
    if (!ChatModelsCache.instance) {
      ChatModelsCache.instance = new ChatModelsCache();
    }
    return ChatModelsCache.instance;
  }

  private startInitialization(): Promise<ChatModelsInitializationResult> {
    if (this.cachedModels.length > 0) {
      return Promise.resolve({ models: this.cachedModels });
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    const runId = ++this.initializationRunId;
    const runPromise = (async (): Promise<ChatModelsInitializationResult> => {
      try {
        logger.info("Initializing chat models cache...");
        const models = await selectSupportedModels();
        if (this.initializationRunId === runId) {
          this.cachedModels = models;
        }
        return { models };
      } catch (error) {
        const initError =
          error instanceof Error
            ? error
            : new Error("Failed to discover Copilot models", { cause: error });
        logger.error("Failed to initialize chat models cache:", error);
        if (this.initializationRunId === runId) {
          this.cachedModels = [];
        }
        return { models: [], error: initError };
      } finally {
        if (this.initializationRunId === runId) {
          this.initializationPromise = null;
        }
      }
    })();

    this.initializationPromise = runPromise;
    return runPromise;
  }

  async initialize(): Promise<void> {
    await this.startInitialization();
  }

  async getChatModels(
    options: { throwOnError?: boolean } = {},
  ): Promise<vscode.LanguageModelChat[]> {
    const { models, error } = await this.startInitialization();
    if (options.throwOnError && error) {
      throw error;
    }
    return models;
  }

  async refresh(): Promise<void> {
    this.invalidate();
    await this.initialize();
  }

  /**
   * Drops cached model handles so the next lookup re-queries VS Code. Each
   * handle captures the internal model ID that existed at discovery time; if
   * VS Code later re-registers the model under another ID, the old handle
   * fails with "Chat provider ... is not registered".
   */
  invalidate(): void {
    this.initializationRunId++;
    this.cachedModels = [];
    this.initializationPromise = null;
  }

  /**
   * Per the `selectChatModels` contract, handles must be re-queried after
   * `onDidChangeChatModels`. Only invalidate here: enumerating inside the
   * listener could feed back into further change events.
   */
  watchModelChanges(): vscode.Disposable {
    return vscode.lm.onDidChangeChatModels(() => {
      logger.info("VS Code chat models changed; dropping cached model handles");
      this.invalidate();
    });
  }

  getCachedModels(): vscode.LanguageModelChat[] {
    return this.cachedModels;
  }
}

export const chatModelsCache = ChatModelsCache.getInstance();

const chatModelToQuickPickItem = (model: vscode.LanguageModelChat) => ({
  label: model.name,
  description: `${model.vendor} - ${model.id}`,
  modelId: model.id,
  maxInputTokens: model.maxInputTokens,
});

const MAI_FAMILY_OR_ID_PATTERN = /^(?:.*[-_/])?mai(?:$|[-_/])/i;

const MODEL_FAMILIES = [
  {
    id: "claude",
    label: "Claude",
    matches: (model: vscode.LanguageModelChat) =>
      model.family.toLowerCase().includes("claude"),
  },
  {
    id: "openai",
    label: "OpenAI",
    matches: (model: vscode.LanguageModelChat) =>
      model.family.toLowerCase().includes("gpt"),
  },
  {
    id: "gemini",
    label: "Gemini",
    matches: (model: vscode.LanguageModelChat) =>
      model.family.toLowerCase().includes("gemini"),
  },
  {
    id: "grok",
    label: "Grok",
    matches: (model: vscode.LanguageModelChat) =>
      model.family.toLowerCase().includes("grok"),
  },
  {
    id: "mai",
    label: "MAI",
    // Copilot currently reports prompt-slot family names (e.g. vscModelF) on mai-* IDs.
    matches: (model: vscode.LanguageModelChat) =>
      MAI_FAMILY_OR_ID_PATTERN.test(model.family) ||
      MAI_FAMILY_OR_ID_PATTERN.test(model.id),
  },
  {
    id: "other",
    label: "Other",
    matches: () => true,
  },
] as const;

export type ModelFamily = (typeof MODEL_FAMILIES)[number]["id"];
type PriorityModelFamily = Exclude<ModelFamily, "other">;

export interface GetChatModelsOptions {
  recommendedModelId?: string;
  priorityFamily?: PriorityModelFamily;
}

function getFamilyOrder(
  priorityFamily?: PriorityModelFamily,
): (typeof MODEL_FAMILIES)[number][] {
  if (!priorityFamily) {
    return [...MODEL_FAMILIES];
  }

  const prioritized = MODEL_FAMILIES.find(
    (entry) => entry.id === priorityFamily,
  );
  if (!prioritized) {
    return [...MODEL_FAMILIES];
  }

  // Move priority family to front, but keep "other" always at the end
  return [
    prioritized,
    ...MODEL_FAMILIES.filter(
      (entry) => entry.id !== priorityFamily && entry.id !== "other",
    ),
    MODEL_FAMILIES[MODEL_FAMILIES.length - 1],
  ];
}

export const getChatModelsQuickPickItems = async (
  options?: GetChatModelsOptions,
) => {
  // Get available models from cache first, fallback to direct API call
  const allModels = await chatModelsCache.getChatModels();
  if (allModels.length === 0) {
    return [];
  }

  const modelGroups = Object.fromEntries(
    MODEL_FAMILIES.map((entry) => [entry.id, [] as vscode.LanguageModelChat[]]),
  ) as Record<ModelFamily, vscode.LanguageModelChat[]>;
  let recommendedModel: vscode.LanguageModelChat | null = null;

  // Categorize models into families
  for (const m of allModels) {
    if (options?.recommendedModelId && m.id === options.recommendedModelId) {
      recommendedModel = m;
      continue;
    }

    // Copilot reports the routed model's family on "auto", so match by ID instead.
    const matchedFamily =
      (m.id !== "auto" && MODEL_FAMILIES.find((entry) => entry.matches(m))) ||
      MODEL_FAMILIES[MODEL_FAMILIES.length - 1];
    modelGroups[matchedFamily.id].push(m);
  }

  const modelOptions = [];

  // Add recommended model at the top if found
  if (recommendedModel) {
    modelOptions.push(
      {
        kind: vscode.QuickPickItemKind.Separator,
        label: "Recommended",
        modelId: "",
        maxInputTokens: 0,
      },
      {
        ...chatModelToQuickPickItem(recommendedModel),
        label: `${recommendedModel.name}`,
      },
    );
  }

  // Add model families in order based on priority
  const familyOrder = getFamilyOrder(options?.priorityFamily);

  for (const family of familyOrder) {
    const models = modelGroups[family.id];
    if (models.length > 0) {
      models.sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { numeric: true }),
      );
      modelOptions.push(
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: family.label,
          modelId: "",
          maxInputTokens: 0,
        },
        ...models.map(chatModelToQuickPickItem),
      );
    }
  }

  return modelOptions;
};

export type CopilotReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | (string & {});

export interface CopilotModelConfiguration {
  /** Prompt/input token budget used by Copilot for this request. */
  contextSize?: number;
  /** Thinking/reasoning effort level, validated by Copilot against the selected model. */
  reasoningEffort?: CopilotReasoningEffort;
  [key: string]: unknown;
}

interface ChatRequestOptionsWithConfig
  extends vscode.LanguageModelChatRequestOptions {
  configuration?: CopilotModelConfiguration;
}

export function getCopilotModelConfiguration({
  reasoningEffort,
}: {
  reasoningEffort?: unknown;
}): CopilotModelConfiguration {
  const configuration: CopilotModelConfiguration = {};
  if (typeof reasoningEffort === "string" && reasoningEffort.trim()) {
    configuration.reasoningEffort = reasoningEffort.trim();
  }
  return configuration;
}

/**
 * Copilot derives the upstream `prompt_cache_key` from
 * `modelOptions._conversationId`; without it, requests from the same client
 * session are not routed to a shared prompt cache.
 */
export function withCopilotConversationId(
  modelOptions: Record<string, unknown>,
  promptCacheKey: unknown,
): Record<string, unknown> {
  // The key is an opaque client identifier, so forward it verbatim.
  if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
    modelOptions._conversationId = promptCacheKey;
  }
  return modelOptions;
}

/**
 * VS Code stores provider-specific model configuration separately from public
 * `modelOptions`. Copilot reads this bag for settings like context size and
 * reasoning effort.
 */
const LITERAL_SCHEMA_FIELDS = new Set([
  "default",
  "example",
  "examples",
  "const",
  "enum",
  "required",
]);

const SCHEMA_MAP_FIELDS = new Set(["properties", "patternProperties"]);

const STRIPPED_SCHEMA_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "additionalProperties",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLocalSchemaRef(ref: unknown): ref is string {
  return typeof ref === "string" && (ref === "#" || ref.startsWith("#/"));
}

function normalizeSchemaRefPointer(ref: string): string {
  return ref === "#/" ? "#" : ref;
}

function resolveSchemaPointer(
  root: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | null {
  if (pointer === "#" || pointer === "#/") {
    return root;
  }
  const parts = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let target: unknown = root;
  for (const part of parts) {
    if (!isPlainRecord(target)) {
      return null;
    }
    target = target[part];
  }
  return isPlainRecord(target) ? target : null;
}

function mergeResolvedRefWithSiblings(
  resolvedTarget: Record<string, unknown>,
  siblingNode: Record<string, unknown>,
): Record<string, unknown> {
  const { $ref: _ref, ...siblings } = siblingNode;
  if (Object.keys(siblings).length === 0) {
    return resolvedTarget;
  }
  const merged: Record<string, unknown> = {
    ...resolvedTarget,
    ...siblings,
  };
  if (
    isPlainRecord(resolvedTarget.properties) ||
    isPlainRecord(siblings.properties)
  ) {
    const mergedProps: Record<string, unknown> = {
      ...(isPlainRecord(resolvedTarget.properties)
        ? resolvedTarget.properties
        : {}),
    };
    if (isPlainRecord(siblings.properties)) {
      for (const [key, prop] of Object.entries(siblings.properties)) {
        mergedProps[key] = Object.hasOwn(mergedProps, key)
          ? mergeUnionPropertySchemas(mergedProps[key], prop)
          : prop;
      }
    }
    merged.properties = mergedProps;
  }
  if (
    Array.isArray(resolvedTarget.required) ||
    Array.isArray(siblings.required)
  ) {
    const reqTarget = Array.isArray(resolvedTarget.required)
      ? resolvedTarget.required.filter(
          (k): k is string => typeof k === "string",
        )
      : [];
    const reqSibling = Array.isArray(siblings.required)
      ? siblings.required.filter((k): k is string => typeof k === "string")
      : [];
    const unionReq = [...new Set([...reqTarget, ...reqSibling])];
    if (unionReq.length > 0) {
      merged.required = unionReq;
    } else {
      delete merged.required;
    }
  }
  return merged;
}

function primarySchemaType(node: Record<string, unknown>): string | undefined {
  if (typeof node.type === "string") {
    return node.type;
  }
  if (Array.isArray(node.type)) {
    return node.type.find(
      (t): t is string => typeof t === "string" && t !== "null",
    );
  }
  return undefined;
}

function extractAllowedLiterals(
  prop: Record<string, unknown>,
): unknown[] | null {
  if (Array.isArray(prop.enum)) {
    return prop.enum.filter((entry) => entry !== null);
  }
  if (Object.hasOwn(prop, "const") && prop.const !== null) {
    return [prop.const];
  }
  return null;
}

function mergeUnionPropertySchemas(
  existing: unknown,
  incoming: unknown,
): unknown {
  if (!isPlainRecord(existing) || !isPlainRecord(incoming)) {
    return existing;
  }

  const existingLiterals = extractAllowedLiterals(existing);
  const incomingLiterals = extractAllowedLiterals(incoming);
  if (existingLiterals !== null && incomingLiterals !== null) {
    const { const: _c1, enum: _e1, ...rest } = existing;
    const mergedLiterals = [
      ...new Set([...existingLiterals, ...incomingLiterals]),
    ];
    const allStrings = mergedLiterals.every((v) => typeof v === "string");
    const allNumbers = mergedLiterals.every((v) => typeof v === "number");
    const typeA = primarySchemaType(existing);
    const typeB = primarySchemaType(incoming);
    const mergedType =
      typeA && typeB && typeA !== typeB
        ? allStrings
          ? "string"
          : allNumbers
            ? "number"
            : "string"
        : (typeA ?? typeB);
    return {
      ...rest,
      ...(mergedType ? { type: mergedType } : {}),
      enum: mergedLiterals.map((v) =>
        mergedType === "string" && typeof v !== "string" ? String(v) : v,
      ),
    };
  }

  if (existingLiterals !== null || incomingLiterals !== null) {
    const base = existingLiterals !== null ? existing : incoming;
    const other = existingLiterals !== null ? incoming : existing;
    const { const: _c, enum: _e, ...rest } = base;
    const typeA = primarySchemaType(base);
    const typeB = primarySchemaType(other);
    if (typeA && typeB && typeA !== typeB) {
      return { ...rest, type: "string" };
    }
    return rest;
  }

  if (
    isPlainRecord(existing.properties) &&
    isPlainRecord(incoming.properties)
  ) {
    const mergedProps: Record<string, unknown> = { ...existing.properties };
    for (const [k, v] of Object.entries(incoming.properties)) {
      mergedProps[k] = Object.hasOwn(mergedProps, k)
        ? mergeUnionPropertySchemas(mergedProps[k], v)
        : v;
    }
    const reqA = Array.isArray(existing.required)
      ? new Set(
          existing.required.filter((k): k is string => typeof k === "string"),
        )
      : new Set<string>();
    const reqB = Array.isArray(incoming.required)
      ? new Set(
          incoming.required.filter((k): k is string => typeof k === "string"),
        )
      : new Set<string>();
    const commonReq = [...reqA].filter((k) => reqB.has(k));
    const { required: _r, ...rest } = existing;
    return {
      ...rest,
      type: "object",
      properties: mergedProps,
      ...(commonReq.length > 0 ? { required: commonReq } : {}),
    };
  }

  const typeA = primarySchemaType(existing);
  const typeB = primarySchemaType(incoming);
  if (
    (typeA === "array" || isPlainRecord(existing.items)) &&
    (typeB === "array" || isPlainRecord(incoming.items))
  ) {
    const {
      minItems: minA,
      maxItems: maxA,
      uniqueItems: uniqA,
      items: itemsA,
      ...rest
    } = existing;
    const minB = incoming.minItems;
    const maxB = incoming.maxItems;
    const uniqB = incoming.uniqueItems;
    const itemsB = incoming.items;
    const mergedItems =
      isPlainRecord(itemsA) && isPlainRecord(itemsB)
        ? mergeUnionPropertySchemas(itemsA, itemsB)
        : isPlainRecord(itemsA)
          ? itemsA
          : isPlainRecord(itemsB)
            ? itemsB
            : undefined;
    return {
      ...rest,
      type: "array",
      ...(mergedItems ? { items: mergedItems } : {}),
      ...(typeof minA === "number" && typeof minB === "number"
        ? { minItems: Math.min(minA, minB) }
        : {}),
      ...(typeof maxA === "number" && typeof maxB === "number"
        ? { maxItems: Math.max(maxA, maxB) }
        : {}),
      ...(uniqA === true && uniqB === true ? { uniqueItems: true } : {}),
    };
  }
  if (typeA && typeB && typeA !== typeB) {
    const isNumPair =
      (typeA === "integer" && typeB === "number") ||
      (typeA === "number" && typeB === "integer");
    const description =
      typeof existing.description === "string" && existing.description
        ? { description: existing.description }
        : typeof incoming.description === "string" && incoming.description
          ? { description: incoming.description }
          : {};
    return { type: isNumPair ? "number" : "string", ...description };
  }

  return existing;
}

function flattenUnionObjectSchema(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
  seenRefs = new Set<string>(["#"]),
): Record<string, unknown> | null {
  function deref(node: unknown, seen = new Set<string>(seenRefs)): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => deref(item, seen));
    }
    if (!isPlainRecord(node)) {
      return node;
    }
    if (isLocalSchemaRef(node.$ref)) {
      const normalizedRef = normalizeSchemaRefPointer(node.$ref);
      const description =
        typeof node.description === "string" && node.description
          ? { description: node.description }
          : {};
      if (seen.has(normalizedRef)) {
        return { type: "string", ...description };
      }
      const target = resolveSchemaPointer(root, normalizedRef);
      if (!target) {
        return { type: "string", ...description };
      }
      const nextSeen = new Set([...seen, normalizedRef]);
      const resolvedTarget = deref(target, nextSeen);
      if (!isPlainRecord(resolvedTarget)) {
        return { type: "string", ...description };
      }
      const resolvedSiblings = deref(
        Object.fromEntries(
          Object.entries(node).filter(([key]) => key !== "$ref"),
        ),
        nextSeen,
      );
      return isPlainRecord(resolvedSiblings)
        ? mergeResolvedRefWithSiblings(resolvedTarget, resolvedSiblings)
        : { ...resolvedTarget, ...description };
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key))
        .map(([key, item]) => {
          if (LITERAL_SCHEMA_FIELDS.has(key)) {
            return [key, item];
          }
          if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(item)) {
            return [
              key,
              Object.fromEntries(
                Object.entries(item).map(([propName, propSchema]) => [
                  propName,
                  deref(propSchema, seen),
                ]),
              ),
            ];
          }
          return [key, deref(item, seen)];
        }),
    );
  }

  const resolved = deref(schema);
  if (!isPlainRecord(resolved)) {
    return null;
  }

  const properties: Record<string, unknown> = {};
  const parentRequired = Array.isArray(resolved.required)
    ? resolved.required.filter((key): key is string => typeof key === "string")
    : [];
  const branchRequiredSets: Set<string>[] = [];

  function collectProperties(propsRecord: Record<string, unknown>): void {
    for (const [key, prop] of Object.entries(propsRecord)) {
      if (!Object.hasOwn(properties, key)) {
        properties[key] = prop;
      } else {
        properties[key] = mergeUnionPropertySchemas(properties[key], prop);
      }
    }
  }

  function collectBranch(node: unknown): void {
    if (!isPlainRecord(node)) {
      return;
    }
    const oneOf = Array.isArray(node.oneOf) ? node.oneOf : [];
    const anyOf = Array.isArray(node.anyOf) ? node.anyOf : [];
    const subBranches = [...oneOf, ...anyOf];

    if (
      isPlainRecord(node.properties) &&
      Object.keys(node.properties).length > 0
    ) {
      collectProperties(node.properties);
    }

    if (subBranches.length > 0) {
      for (const branch of subBranches) {
        collectBranch(branch);
      }
      return;
    }

    if (node.type === "object" || isPlainRecord(node.properties)) {
      const req = Array.isArray(node.required)
        ? new Set(
            node.required.filter(
              (key): key is string => typeof key === "string",
            ),
          )
        : new Set<string>();
      branchRequiredSets.push(req);
    }
  }

  if (
    isPlainRecord(resolved.properties) &&
    Object.keys(resolved.properties).length > 0
  ) {
    collectProperties(resolved.properties);
  }
  const topBranches = [
    ...(Array.isArray(resolved.oneOf) ? resolved.oneOf : []),
    ...(Array.isArray(resolved.anyOf) ? resolved.anyOf : []),
  ];
  for (const branch of topBranches) {
    collectBranch(branch);
  }

  if (Object.keys(properties).length === 0) {
    return null;
  }

  const intersectedBranchRequired =
    branchRequiredSets.length > 0
      ? [...branchRequiredSets[0]].filter((key) =>
          branchRequiredSets.every((set) => set.has(key)),
        )
      : [];

  const commonRequired = [
    ...new Set([...parentRequired, ...intersectedBranchRequired]),
  ].filter((key) => Object.hasOwn(properties, key));

  const normalizedProperties = Object.fromEntries(
    Object.entries(properties).map(([key, prop]) => [
      key,
      normalizeCopilotToolSchema(prop, root, seenRefs),
    ]),
  );

  return {
    type: "object",
    properties: normalizedProperties,
    ...(commonRequired.length > 0 ? { required: commonRequired } : {}),
  };
}

function extractNameOnlyBranchDiscriminator(
  option: unknown,
  root: Record<string, unknown>,
  seenRefs: Set<string>,
): { names: string[]; requiresName: boolean } | null {
  const resolved =
    isPlainRecord(option) &&
    isLocalSchemaRef(option.$ref) &&
    !seenRefs.has(normalizeSchemaRefPointer(option.$ref))
      ? resolveSchemaPointer(root, normalizeSchemaRefPointer(option.$ref))
      : option;
  if (!isPlainRecord(resolved) || !isPlainRecord(resolved.properties)) {
    return null;
  }
  const branchRequired = Array.isArray(resolved.required)
    ? resolved.required.filter((req): req is string => typeof req === "string")
    : [];
  if (branchRequired.some((req) => req !== "name")) {
    return null;
  }
  const nameProp = resolved.properties.name;
  if (!isPlainRecord(nameProp)) {
    return null;
  }
  const names = Array.isArray(nameProp.enum)
    ? nameProp.enum.filter((v): v is string => typeof v === "string")
    : typeof nameProp.const === "string"
      ? [nameProp.const]
      : [];
  if (names.length === 0) {
    return null;
  }
  return {
    names,
    requiresName: branchRequired.includes("name"),
  };
}

function tryCollapseNameDiscriminatedItemUnion(
  current: Record<string, unknown>,
  rootSchema: Record<string, unknown>,
  seenRefs: Set<string>,
): Record<string, unknown> | null {
  const currentItems = isPlainRecord(current.items) ? current.items : undefined;
  const itemAnyOf = Array.isArray(currentItems?.anyOf)
    ? currentItems.anyOf
    : undefined;
  const nonNullBranches = itemAnyOf?.filter(
    (option) => isPlainRecord(option) && option.type !== "null",
  );
  if (!currentItems || !nonNullBranches || nonNullBranches.length <= 4) {
    return null;
  }
  const parentRequired = Array.isArray(currentItems.required)
    ? currentItems.required.filter((r): r is string => typeof r === "string")
    : [];
  if (parentRequired.some((r) => r !== "name")) {
    return null;
  }
  const branchInfos = nonNullBranches.map((option) =>
    extractNameOnlyBranchDiscriminator(option, rootSchema, seenRefs),
  );
  if (
    branchInfos.some(
      (info): info is null => info === null || info.names.length === 0,
    )
  ) {
    return null;
  }
  const validInfos = branchInfos as Array<{
    names: string[];
    requiresName: boolean;
  }>;
  const mergedNames = [...new Set(validInfos.flatMap((info) => info.names))];
  const itemType = primarySchemaType(currentItems) ?? "object";
  const normalizedContainer = Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key) && key !== "items")
      .map(([key, item]) => [
        key,
        LITERAL_SCHEMA_FIELDS.has(key)
          ? item
          : normalizeCopilotToolSchema(item, rootSchema, seenRefs),
      ]),
  );
  const collapsedItemSchema: Record<string, unknown> = {
    type: itemType,
    properties: { name: { type: "string", enum: mergedNames } },
  };
  if (
    parentRequired.includes("name") ||
    validInfos.every((info) => info.requiresName)
  ) {
    collapsedItemSchema.required = ["name"];
  }
  return {
    ...normalizedContainer,
    items: collapsedItemSchema,
  };
}

function isCompatibleScalarForItemType(
  entry: unknown,
  itemType: string | undefined,
): boolean {
  if (entry === null || typeof entry === "object") {
    return false;
  }
  if (!itemType) {
    return (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    );
  }
  if (itemType === "string") {
    return typeof entry === "string";
  }
  if (itemType === "integer") {
    return typeof entry === "number" && Number.isInteger(entry);
  }
  if (itemType === "number") {
    return typeof entry === "number" && Number.isFinite(entry);
  }
  if (itemType === "boolean") {
    return typeof entry === "boolean";
  }
  return false;
}

/**
 * Normalize complex JSON Schema constructs ($ref/$defs, nullable type arrays,
 * array-level enums, and large discriminated items.anyOf unions) that Copilot
 * Gemini backends reject with HTTP 400 invalid_request_body.
 */
export function normalizeCopilotToolSchema(
  value: unknown,
  root?: Record<string, unknown>,
  seenRefs = new Set<string>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      normalizeCopilotToolSchema(item, root, seenRefs),
    );
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const obj = value;
  const rootSchema = root ?? obj;
  const effectiveSeenRefs =
    root === undefined ? new Set([...seenRefs, "#"]) : seenRefs;

  if (isLocalSchemaRef(obj.$ref)) {
    const normalizedRef = normalizeSchemaRefPointer(obj.$ref);
    const description =
      typeof obj.description === "string" && obj.description
        ? { description: obj.description }
        : {};
    if (effectiveSeenRefs.has(normalizedRef)) {
      return { type: "string", ...description };
    }
    const target = resolveSchemaPointer(rootSchema, normalizedRef);
    if (!target) {
      return { type: "string", ...description };
    }
    const nextSeen = new Set([...effectiveSeenRefs, normalizedRef]);
    const resolved = normalizeCopilotToolSchema(target, rootSchema, nextSeen);
    if (!isPlainRecord(resolved)) {
      return { type: "string", ...description };
    }
    const siblingEntries = Object.entries(obj).filter(
      ([key]) => key !== "$ref",
    );
    if (siblingEntries.length === 0) {
      return resolved;
    }
    const normalizedSiblings = normalizeCopilotToolSchema(
      Object.fromEntries(siblingEntries),
      rootSchema,
      nextSeen,
    );
    return isPlainRecord(normalizedSiblings)
      ? mergeResolvedRefWithSiblings(resolved, normalizedSiblings)
      : { ...resolved, ...description };
  }

  const hasEmptyProperties =
    !isPlainRecord(obj.properties) || Object.keys(obj.properties).length === 0;

  if (
    (Array.isArray(obj.oneOf) || Array.isArray(obj.anyOf)) &&
    hasEmptyProperties
  ) {
    const flattened = flattenUnionObjectSchema(
      obj,
      rootSchema,
      effectiveSeenRefs,
    );
    if (flattened) {
      return flattened;
    }
    const union = (
      Array.isArray(obj.anyOf) ? obj.anyOf : obj.oneOf
    ) as unknown[];
    const nonNull = union.filter(
      (branch): branch is Record<string, unknown> =>
        isPlainRecord(branch) && branch.type !== "null",
    );
    const description =
      typeof obj.description === "string" && obj.description
        ? { description: obj.description }
        : {};
    if (nonNull.length === 1) {
      const resolved = normalizeCopilotToolSchema(
        nonNull[0],
        rootSchema,
        effectiveSeenRefs,
      );
      return isPlainRecord(resolved)
        ? { ...resolved, ...description }
        : { type: "string", ...description };
    }
    if (nonNull.length > 1) {
      const normalizedBranches = nonNull
        .map((branch) =>
          normalizeCopilotToolSchema(branch, rootSchema, effectiveSeenRefs),
        )
        .filter(isPlainRecord);
      if (
        normalizedBranches.length > 0 &&
        normalizedBranches.every(
          (branch) =>
            primarySchemaType(branch) === "array" ||
            isPlainRecord(branch.items),
        )
      ) {
        const mergedArray = normalizedBranches
          .slice(1)
          .reduce<unknown>(
            (acc, branch) => mergeUnionPropertySchemas(acc, branch),
            normalizedBranches[0],
          );
        const normalizedMerged = normalizeCopilotToolSchema(
          mergedArray,
          rootSchema,
          effectiveSeenRefs,
        );
        if (isPlainRecord(normalizedMerged)) {
          return { ...normalizedMerged, ...description };
        }
      }
      const mergedBranch =
        normalizedBranches.length > 0
          ? normalizedBranches
              .slice(1)
              .reduce<unknown>(
                (acc, branch) => mergeUnionPropertySchemas(acc, branch),
                normalizedBranches[0],
              )
          : undefined;
      if (
        isPlainRecord(mergedBranch) &&
        typeof mergedBranch.type === "string" &&
        !["object", "array"].includes(mergedBranch.type)
      ) {
        return { ...mergedBranch, ...description };
      }
      const primaryType =
        normalizedBranches.find(
          (branch) =>
            typeof branch.type === "string" &&
            !["object", "array"].includes(branch.type),
        )?.type ?? "string";
      return { type: primaryType, ...description };
    }
  }

  let current: Record<string, unknown> = obj;
  if (Array.isArray(current.type)) {
    const nonNull = current.type.filter(
      (t): t is string => typeof t === "string" && t !== "null",
    );
    current = { ...current, type: nonNull[0] ?? "string" };
  }
  if (Array.isArray(current.enum) && current.enum.includes(null)) {
    current = {
      ...current,
      enum: current.enum.filter((entry) => entry !== null),
    };
  }
  if (
    Array.isArray(current.enum) &&
    typeof current.type === "string" &&
    !["string", "integer", "number"].includes(current.type)
  ) {
    const { enum: enumValues, ...rest } = current;
    const items = isPlainRecord(current.items) ? current.items : undefined;
    const itemType = items ? primarySchemaType(items) : undefined;
    const isCompatibleScalarEnum =
      enumValues.length > 0 &&
      enumValues.every((entry) =>
        isCompatibleScalarForItemType(entry, itemType),
      );
    current =
      current.type === "array" &&
      isCompatibleScalarEnum &&
      items &&
      !Array.isArray(items.enum)
        ? {
            ...rest,
            items: {
              ...items,
              enum: enumValues,
            },
          }
        : rest;
  }

  const collapsedItemUnion = tryCollapseNameDiscriminatedItemUnion(
    current,
    rootSchema,
    effectiveSeenRefs,
  );
  if (collapsedItemUnion) {
    return collapsedItemUnion;
  }

  return Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => !STRIPPED_SCHEMA_KEYWORDS.has(key))
      .map(([key, item]) => {
        if (LITERAL_SCHEMA_FIELDS.has(key)) {
          return [key, item];
        }
        if (SCHEMA_MAP_FIELDS.has(key) && isPlainRecord(item)) {
          return [
            key,
            Object.fromEntries(
              Object.entries(item).map(([propName, propSchema]) => [
                propName,
                normalizeCopilotToolSchema(
                  propSchema,
                  rootSchema,
                  effectiveSeenRefs,
                ),
              ]),
            ),
          ];
        }
        return [
          key,
          normalizeCopilotToolSchema(item, rootSchema, effectiveSeenRefs),
        ];
      }),
  );
}

function isCopilotGeminiModel(client: vscode.LanguageModelChat): boolean {
  return (
    client.vendor === SUPPORTED_VENDOR &&
    (client.family.toLowerCase().includes("gemini") ||
      client.id.toLowerCase().includes("gemini"))
  );
}

/**
 * VS Code stores provider-specific model configuration separately from public
 * `modelOptions`. Copilot reads this bag for settings like context size and
 * reasoning effort.
 */
export function withCopilotConfiguration(
  client: vscode.LanguageModelChat,
  options: vscode.LanguageModelChatRequestOptions,
  configuration: CopilotModelConfiguration = {},
): vscode.LanguageModelChatRequestOptions {
  if (client.vendor !== SUPPORTED_VENDOR || client.maxInputTokens <= 0) {
    return options;
  }

  const normalizedTools =
    isCopilotGeminiModel(client) && Array.isArray(options.tools)
      ? options.tools.map((tool) =>
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? {
                ...tool,
                inputSchema: normalizeCopilotToolSchema(
                  tool.inputSchema,
                ) as object,
              }
            : tool,
        )
      : options.tools;

  // Copilot treats contextSize as the prompt/input budget; response tokens stay
  // controlled separately by max_tokens/max_output_tokens in modelOptions.
  const contextSize = client.maxInputTokens;
  const copilotConfiguration: CopilotModelConfiguration = {
    ...configuration,
    contextSize,
  };

  logger.debug(
    `Setting Copilot configuration for ${client.id}: contextSize=${copilotConfiguration.contextSize}, reasoningEffort=${copilotConfiguration.reasoningEffort ?? "default"}`,
  );

  return {
    ...options,
    ...(normalizedTools !== options.tools ? { tools: normalizedTools } : {}),
    configuration: copilotConfiguration,
  } as ChatRequestOptionsWithConfig;
}

/**
 * Calculate Jaccard similarity between two strings based on character bigrams
 */
export function jaccardSimilarity(str1: string, str2: string): number {
  const getBigrams = (str: string): Set<string> => {
    const bigrams = new Set<string>();
    const normalized = str.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (let i = 0; i < normalized.length - 1; i++) {
      bigrams.add(normalized.substring(i, i + 2));
    }
    return bigrams;
  };

  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);

  if (bigrams1.size === 0 && bigrams2.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) {
      intersection++;
    }
  }

  const union = bigrams1.size + bigrams2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find the best matching model using Jaccard similarity
 */
function findBestMatch(
  modelId: string,
  models: vscode.LanguageModelChat[],
): vscode.LanguageModelChat | null {
  if (models.length === 0) {
    return null;
  }

  let bestMatch: vscode.LanguageModelChat | null = null;
  let bestScore = 0;

  for (const model of models) {
    const score = jaccardSimilarity(modelId, model.id);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = model;
    }
  }

  // Only accept matches with a reasonable similarity threshold
  if (bestScore >= 0.3 && bestMatch) {
    logger.info(
      `Fuzzy matched model "${modelId}" to "${bestMatch.id}" (similarity: ${bestScore.toFixed(2)})`,
    );
    return bestMatch;
  }

  return null;
}

/**
 * Get chat model client with integrated model mapping logic
 *
 * This function handles:
 * 1. Exact match lookup
 * 2. Fuzzy matching using Jaccard similarity
 * 3. Configured fallback model
 * 4. Fallback to "auto" or first available model
 *
 * Note: We don't refresh the cache if a model isn't found because vscode.lm.selectChatModels()
 * doesn't update dynamically when network state changes - the VS Code API returns the same
 * cached results regardless of VPN/network changes during the session.
 */
/**
 * Whether `sendRequest` failed because the handle points at a model ID VS Code
 * no longer knows, rather than because of auth, quota, or the network.
 *
 * Both checks mirror upstream VS Code: the extension host throws
 * `LanguageModelError.NotFound` when its own entry is gone, while the main
 * thread throws a plain `Error` when only its model cache dropped the ID
 * (`languageModels.ts` `sendChatRequest`). The second case is what stale
 * handles hit after Copilot re-registers models during startup.
 */
export function isStaleModelHandleError(error: unknown): boolean {
  if (error instanceof vscode.LanguageModelError) {
    return error.code === vscode.LanguageModelError.NotFound.name;
  }
  return (
    error instanceof Error &&
    /^Chat provider for model .+ is not registered\.?$/.test(error.message)
  );
}

export const getChatModelClient = async (modelId: string) => {
  const models = await chatModelsCache.getChatModels();

  let client = models.find((model) => model.id === modelId);
  if (client) {
    return { client };
  }

  const fuzzyMatch = findBestMatch(modelId, models);
  if (fuzzyMatch) {
    return { client: fuzzyMatch };
  }

  const fallbackModelId = readConfiguration().fallbackModelId.trim();
  if (fallbackModelId) {
    client = models.find((model) => model.id === fallbackModelId);
    if (client) {
      warnedUnavailableFallbackModelIds.delete(fallbackModelId);
      logger.info(
        `Model "${modelId}" not found, using configured fallback model: ${client.id}`,
      );
      return { client };
    }
    if (!warnedUnavailableFallbackModelIds.has(fallbackModelId)) {
      warnedUnavailableFallbackModelIds.add(fallbackModelId);
      logger.warn(
        `Configured fallback model "${fallbackModelId}" is unavailable; continuing with automatic fallback`,
      );
    }
  }

  const autoModel = models.find((model) => model.id === "auto");
  if (autoModel) {
    logger.info(`Model "${modelId}" not found, using auto model`);
    return { client: autoModel };
  }

  if (models.length > 0) {
    const fallback = models[0];
    logger.info(
      `Model "${modelId}" not found, using first available model: ${fallback.id}`,
    );
    return { client: fallback };
  }

  // No models available at all
  logger.error(`No VS Code LM model available for model ID: ${modelId}`);
  return {
    error: {
      error: {
        message: `Model '${modelId}' not found and no fallback models available. Use /api/v1/lm/chatModels to list available models.`,
        type: "invalid_request_error",
      },
    },
  };
};
