import * as vscode from "vscode";

import { logger } from "./logger";

class ChatModelsCache {
  private static instance: ChatModelsCache;
  private _cachedModels: vscode.LanguageModelChat[] = [];
  private initializationPromise: Promise<void> | null = null;

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
        this.cachedModels = await vscode.lm.selectChatModels({});
        logger.info(`Cached ${this.cachedModels.length} chat models`);
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
        },
        ...models.map(chatModelToQuickPickItem),
      );
    }
  }

  return modelOptions;
};

/**
 * Get chat model client with integrated override logic
 */
export const getChatModelClient = async (modelId: string) => {
  const models = await chatModelsCache.getChatModels();
  const client = models.find((m) => m.id === modelId);

  if (!client) {
    logger.error(`No VS Code LM model available for model ID: ${modelId}`);
    return {
      error: {
        error: {
          message: `Model '${modelId}' not found. Use /api/v1/lm/chatModels to list available models and pass a valid model ID.`,
          type: "invalid_request_error",
        },
        type: "error",
      },
    };
  }

  return { client };
};
