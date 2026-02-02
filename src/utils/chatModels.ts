import * as vscode from "vscode";

import { logger } from "./logger";

class ChatModelsCache {
  private static instance: ChatModelsCache;
  private _cachedModels: vscode.LanguageModelChat[] = [];
  private initializationPromise: Promise<void> | null = null;
  private hasShownNoClaudeWarning = false;

  // Getter that filters out claude-3.7 models by default due to model_not_supported error
  private get cachedModels(): vscode.LanguageModelChat[] {
    return this._cachedModels.filter((m) => !m.id.includes("claude-3.7"));
  }

  // Setter for internal use
  private set cachedModels(models: vscode.LanguageModelChat[]) {
    this._cachedModels = models;
  }

  private constructor() {}

  static getInstance(): ChatModelsCache {
    if (!ChatModelsCache.instance) {
      ChatModelsCache.instance = new ChatModelsCache();
    }
    return ChatModelsCache.instance;
  }

  async initialize(): Promise<void> {
    if (this.cachedModels.length > 0) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = (async () => {
      try {
        logger.info("Initializing chat models cache...");
        this.cachedModels = await vscode.lm.selectChatModels();
        logger.info(`Cached ${this.cachedModels.length} chat models`);

        // Check for Claude models availability and show warning once if none found
        if (this.cachedModels.length > 0 && !this.hasShownNoClaudeWarning) {
          const hasClaudeModels = this.cachedModels.some((m) =>
            m.id.toLowerCase().includes("claude"),
          );
          if (!hasClaudeModels) {
            this.hasShownNoClaudeWarning = true;
            vscode.window.showWarningMessage(
              "No Claude models found. Please check your network or VPN settings.",
            );
          }
        }
      } catch (error) {
        logger.error("Failed to initialize chat models cache:", error);
        this.cachedModels = [];
      } finally {
        this.initializationPromise = null;
      }
    })();

    return this.initializationPromise;
  }

  async getChatModels(): Promise<vscode.LanguageModelChat[]> {
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    await this.initialize();
    return this.cachedModels;
  }

  async refresh(): Promise<void> {
    this.cachedModels = [];
    this.initializationPromise = null;
    await this.initialize();
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

export type ModelFamily = "claude" | "gemini" | "openai" | "other";

export interface GetChatModelsOptions {
  recommendedModelId?: string;
  priorityFamily?: "claude" | "gemini" | "openai";
}

function getFamilyOrder(
  priorityFamily?: "claude" | "gemini" | "openai",
): ModelFamily[] {
  const defaultOrder: ModelFamily[] = ["claude", "openai", "gemini", "other"];

  if (!priorityFamily) {
    return defaultOrder;
  }

  // Move priority family to front, but keep "other" always at the end
  return [
    priorityFamily,
    ...defaultOrder.filter((f) => f !== priorityFamily && f !== "other"),
    "other",
  ];
}

function getFamilyLabel(family: ModelFamily): string {
  const labels: Record<ModelFamily, string> = {
    claude: "Claude",
    openai: "OpenAI",
    gemini: "Gemini",
    other: "Other",
  };
  return labels[family];
}

export const getChatModelsQuickPickItems = async (
  options?: GetChatModelsOptions,
) => {
  // Get available models from cache first, fallback to direct API call
  let allModels = await chatModelsCache.getChatModels();
  if (allModels.length === 0) {
    return [];
  }

  const modelGroups: Record<ModelFamily, vscode.LanguageModelChat[]> = {
    claude: [],
    gemini: [],
    openai: [],
    other: [],
  };
  let recommendedModel: vscode.LanguageModelChat | null = null;

  // Categorize models into families
  for (const m of allModels) {
    if (options?.recommendedModelId && m.id === options.recommendedModelId) {
      recommendedModel = m;
    } else if (m.family.includes("claude")) {
      modelGroups.claude.push(m);
    } else if (m.family.includes("gemini")) {
      modelGroups.gemini.push(m);
    } else if (m.family.includes("gpt")) {
      modelGroups.openai.push(m);
    } else {
      modelGroups.other.push(m);
    }
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
    const models = modelGroups[family];
    if (models.length > 0) {
      modelOptions.push(
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: getFamilyLabel(family),
          modelId: "",
          maxInputTokens: 0,
        },
        ...models.map(chatModelToQuickPickItem),
      );
    }
  }

  return modelOptions;
};

/**
 * Calculate Jaccard similarity between two strings based on character bigrams
 */
function jaccardSimilarity(str1: string, str2: string): number {
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
 * 3. Fallback to "auto" or first available model
 *
 * Note: We don't refresh the cache if a model isn't found because vscode.lm.selectChatModels()
 * doesn't update dynamically when network state changes - the VS Code API returns the same
 * cached results regardless of VPN/network changes during the session.
 */
export const getChatModelClient = async (modelId: string) => {
  const models = await chatModelsCache.getChatModels();

  // 1. Try exact match
  let client = models.find((m) => m.id === modelId);
  if (client) {
    return { client };
  }

  // 2. Try fuzzy matching with Jaccard similarity
  const fuzzyMatch = findBestMatch(modelId, models);
  if (fuzzyMatch) {
    return { client: fuzzyMatch };
  }

  // 3. Fallback to "auto" or first model
  const autoModel = models.find((m) => m.id === "auto");
  client = models.find((m) => m.version === autoModel?.version);
  if (client) {
    logger.info(`Model "${modelId}" not found, using ${client.id} model`);
    return { client };
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
