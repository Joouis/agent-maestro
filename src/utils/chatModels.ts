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
 * Convert Anthropic API model ID to VSCode LM API model ID
 */
export const convertAnthropicModelToVSCodeModel = (modelId: string): string => {
  // Remove date suffix (pattern: -YYYYMMDD at the end) for accurate pattern matching
  const withoutDate = modelId.replace(/-\d{8}$/, "");

  // Handle different model patterns
  if (withoutDate === "claude-opus-4-1") {
    return "claude-opus-41";
  }

  if (withoutDate === "claude-opus-4") {
    return "claude-opus-4";
  }

  if (withoutDate === "claude-sonnet-4") {
    return "claude-sonnet-4";
  }

  // Handle claude-3-5-haiku -> claude-3.5-sonnet
  if (withoutDate === "claude-3-5-haiku") {
    return "claude-3.5-sonnet";
  }

  // Handle claude-3-haiku -> claude-3.5-sonnet
  if (withoutDate === "claude-3-haiku") {
    return "claude-3.5-sonnet";
  }

  // If no pattern matches or claude-3-7 models, return a default model ID as fallback
  logger.warn(
    `No matching model found for ID: ${modelId}. Falling back to default model ID "claude-3.5-sonnet".`,
  );
  return "claude-3.5-sonnet";
};

/**
 * Generic function to get a chat model client with automatic model conversion
 */
const ANTHROPIC_MODEL_PREFIX = "claude";
export const getChatModelClient = async (modelId: string) => {
  // Convert official Anthropic API model ID to VSCode LM API model ID
  const vsCodeModelId = modelId.startsWith(ANTHROPIC_MODEL_PREFIX)
    ? convertAnthropicModelToVSCodeModel(modelId)
    : modelId;

  const models = await chatModelsCache.getChatModels();
  const client = models.find((m) => m.id === vsCodeModelId);

  if (!client) {
    logger.error(
      `No VS Code LM model available for model ID: ${modelId} (converted to: ${vsCodeModelId})`,
    );
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
