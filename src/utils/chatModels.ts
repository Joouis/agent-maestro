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
function resolveSchemaPointer(
  root: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | null {
  const parts = pointer
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let target: unknown = root;
  for (const part of parts) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return null;
    }
    target = (target as Record<string, unknown>)[part];
  }
  return target && typeof target === "object" && !Array.isArray(target)
    ? (target as Record<string, unknown>)
    : null;
}

function flattenUnionObjectSchema(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
): Record<string, unknown> | null {
  const defs =
    schema.$defs &&
    typeof schema.$defs === "object" &&
    !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : {};

  function deref(node: unknown, seen = new Set<string>()): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => deref(item, seen));
    }
    if (!node || typeof node !== "object") {
      return node;
    }
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/$defs/")) {
      const key = obj.$ref.slice("#/$defs/".length);
      if (!seen.has(key) && Object.hasOwn(defs, key)) {
        return deref(defs[key], new Set([...seen, key]));
      }
    }
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([key]) => key !== "$defs")
        .map(([key, item]) => [key, deref(item, seen)]),
    );
  }

  const resolved = deref(schema);
  const properties: Record<string, unknown> = {};
  const requiredSets: Set<string>[] = [];

  function collect(node: unknown): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      obj.properties &&
      typeof obj.properties === "object" &&
      !Array.isArray(obj.properties) &&
      Object.keys(obj.properties).length > 0
    ) {
      if (Array.isArray(obj.required)) {
        requiredSets.push(
          new Set(
            obj.required.filter(
              (key): key is string => typeof key === "string",
            ),
          ),
        );
      }
      for (const [key, prop] of Object.entries(
        obj.properties as Record<string, unknown>,
      )) {
        if (!Object.hasOwn(properties, key)) {
          properties[key] = prop;
        } else {
          const existing = properties[key] as
            | Record<string, unknown>
            | undefined;
          const incoming = prop as Record<string, unknown> | undefined;
          if (Array.isArray(existing?.enum) && Array.isArray(incoming?.enum)) {
            properties[key] = {
              ...existing,
              enum: [...new Set([...existing.enum, ...incoming.enum])],
            };
          }
        }
      }
    }
    const oneOf = Array.isArray(obj.oneOf) ? obj.oneOf : [];
    const anyOf = Array.isArray(obj.anyOf) ? obj.anyOf : [];
    for (const branch of [...oneOf, ...anyOf]) {
      collect(branch);
    }
  }

  collect(resolved);
  if (Object.keys(properties).length === 0) {
    return null;
  }

  const commonRequired =
    requiredSets.length > 0
      ? [...requiredSets[0]].filter(
          (key) =>
            Object.hasOwn(properties, key) &&
            requiredSets.every((set) => set.has(key)),
        )
      : [];

  return {
    type: "object",
    properties: normalizeCopilotToolSchema(properties, root),
    ...(commonRequired.length > 0 ? { required: commonRequired } : {}),
  };
}

/**
 * Normalize complex JSON Schema constructs ($ref/$defs, nullable type arrays,
 * array-level enums, and large discriminated anyOf/oneOf unions) that Copilot
 * Chat Completions / Gemini backends reject with HTTP 400 invalid_request_body.
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
  if (!value || typeof value !== "object") {
    return value;
  }

  const obj = value as Record<string, unknown>;
  const rootSchema = root ?? obj;

  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
    const description =
      typeof obj.description === "string" && obj.description
        ? { description: obj.description }
        : {};
    if (seenRefs.has(obj.$ref)) {
      return { type: "string", ...description };
    }
    const target = resolveSchemaPointer(rootSchema, obj.$ref);
    if (!target) {
      return { type: "string", ...description };
    }
    const resolved = normalizeCopilotToolSchema(
      target,
      rootSchema,
      new Set([...seenRefs, obj.$ref]),
    );
    return resolved && typeof resolved === "object" && !Array.isArray(resolved)
      ? { ...(resolved as Record<string, unknown>), ...description }
      : { type: "string", ...description };
  }

  const hasEmptyProperties =
    !obj.properties ||
    typeof obj.properties !== "object" ||
    Array.isArray(obj.properties) ||
    Object.keys(obj.properties).length === 0;

  if (
    (Array.isArray(obj.oneOf) || Array.isArray(obj.anyOf)) &&
    hasEmptyProperties
  ) {
    const flattened = flattenUnionObjectSchema(obj, rootSchema);
    if (flattened) {
      return flattened;
    }
    const union = (
      Array.isArray(obj.anyOf) ? obj.anyOf : obj.oneOf
    ) as unknown[];
    const nonNull = union.filter(
      (branch): branch is Record<string, unknown> =>
        Boolean(branch) &&
        typeof branch === "object" &&
        !Array.isArray(branch) &&
        (branch as Record<string, unknown>).type !== "null",
    );
    const description =
      typeof obj.description === "string" && obj.description
        ? { description: obj.description }
        : {};
    if (nonNull.length === 1) {
      const resolved = normalizeCopilotToolSchema(
        nonNull[0],
        rootSchema,
        seenRefs,
      );
      return resolved &&
        typeof resolved === "object" &&
        !Array.isArray(resolved)
        ? { ...(resolved as Record<string, unknown>), ...description }
        : { type: "string", ...description };
    }
    if (nonNull.length > 1) {
      const primaryType =
        nonNull.find(
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
    const items = current.items;
    current =
      current.type === "array" &&
      items &&
      typeof items === "object" &&
      !Array.isArray(items) &&
      !Array.isArray((items as Record<string, unknown>).enum)
        ? {
            ...rest,
            items: {
              ...(items as Record<string, unknown>),
              enum: enumValues,
            },
          }
        : rest;
  }

  const currentItems =
    current.items &&
    typeof current.items === "object" &&
    !Array.isArray(current.items)
      ? (current.items as Record<string, unknown>)
      : undefined;

  if (Array.isArray(currentItems?.anyOf) && currentItems.anyOf.length > 4) {
    const names = [
      ...new Set(
        currentItems.anyOf.flatMap((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return [];
          }
          const props = (option as Record<string, unknown>).properties;
          if (!props || typeof props !== "object" || Array.isArray(props)) {
            return [];
          }
          const nameProp = (props as Record<string, unknown>).name;
          if (
            !nameProp ||
            typeof nameProp !== "object" ||
            Array.isArray(nameProp)
          ) {
            return [];
          }
          const enumList = (nameProp as Record<string, unknown>).enum;
          return Array.isArray(enumList) ? enumList : [];
        }),
      ),
    ].filter((name): name is string => typeof name === "string");

    const itemType = Array.isArray(currentItems.type)
      ? (currentItems.type.find(
          (t): t is string => typeof t === "string" && t !== "null",
        ) ?? "object")
      : typeof currentItems.type === "string"
        ? currentItems.type
        : "object";

    const requiredList = Array.isArray(currentItems.required)
      ? currentItems.required
      : [];

    return {
      ...Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => !["$defs", "additionalProperties"].includes(key),
        ),
      ),
      items: {
        type: itemType,
        properties:
          names.length > 0 ? { name: { type: "string", enum: names } } : {},
        ...(requiredList.includes("name") ? { required: ["name"] } : {}),
      },
    };
  }

  return Object.fromEntries(
    Object.entries(current)
      .filter(([key]) => !["$defs", "additionalProperties"].includes(key))
      .map(([key, item]) => [
        key,
        normalizeCopilotToolSchema(item, rootSchema, seenRefs),
      ]),
  );
}

export function withCopilotConfiguration(
  client: vscode.LanguageModelChat,
  options: vscode.LanguageModelChatRequestOptions,
  configuration: CopilotModelConfiguration = {},
): vscode.LanguageModelChatRequestOptions {
  const normalizedTools = Array.isArray(options.tools)
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
  const normalizedOptions =
    normalizedTools !== options.tools
      ? { ...options, tools: normalizedTools }
      : options;

  if (client.vendor !== SUPPORTED_VENDOR || client.maxInputTokens <= 0) {
    return normalizedOptions;
  }

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
    ...normalizedOptions,
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
