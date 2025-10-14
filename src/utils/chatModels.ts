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

export const getChatModelsQuickPickItems = async (recommended?: string) => {
  // Get available models from cache first, fallback to direct API call
  let allModels = await chatModelsCache.getChatModels();
  if (allModels.length === 0) {
    return [];
  }

  const claudeModels = [];
  const geminiModels = [];
  const restModels = [];
  let recommendedModel = null;

  for (const m of allModels) {
    if (recommended && m.id === recommended) {
      recommendedModel = m;
    }

    if (m.id.toLocaleLowerCase().includes("claude")) {
      claudeModels.push(m);
    } else if (m.id.toLocaleLowerCase().includes("gemini")) {
      geminiModels.push(m);
    } else {
      restModels.push(m);
    }
  }

  // Show model selection for ANTHROPIC_MODEL
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

  // Add the rest of the models in their categories
  modelOptions.push(
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: "Claude",
      modelId: "",
    },
    ...claudeModels.map(chatModelToQuickPickItem),
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: "OpenAI",
      modelId: "",
    },
    ...restModels.map(chatModelToQuickPickItem),
    {
      kind: vscode.QuickPickItemKind.Separator,
      label: "Gemini",
      modelId: "",
    },
    ...geminiModels.map(chatModelToQuickPickItem),
  );

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
