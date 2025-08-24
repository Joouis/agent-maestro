import * as vscode from "vscode";

import { logger } from "./logger";

class ChatModelsCache {
  private static instance: ChatModelsCache;
  private cachedModels: vscode.LanguageModelChat[] = [];
  private isInitializing = false;

  private constructor() {}

  static getInstance(): ChatModelsCache {
    if (!ChatModelsCache.instance) {
      ChatModelsCache.instance = new ChatModelsCache();
    }
    return ChatModelsCache.instance;
  }

  async initialize(): Promise<void> {
    if (this.cachedModels.length > 0 || this.isInitializing) {
      return;
    }

    this.isInitializing = true;
    try {
      logger.info("Initializing chat models cache...");
      this.cachedModels = await vscode.lm.selectChatModels({});
      logger.info(`Cached ${this.cachedModels.length} chat models`);
    } catch (error) {
      logger.error("Failed to initialize chat models cache:", error);
      this.cachedModels = [];
    } finally {
      this.isInitializing = false;
    }
  }

  async getChatModels(): Promise<vscode.LanguageModelChat[]> {
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    if (this.isInitializing) {
      // Wait for initialization to complete
      while (this.isInitializing) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return this.cachedModels;
    }

    // No cached models and not initializing, fetch them now
    await this.initialize();
    return this.cachedModels;
  }

  refresh(): void {
    this.cachedModels = [];
    this.initialize();
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

export const getChatModelsQuickPickItems = async () => {
  // Get available models from cache first, fallback to direct API call
  let allModels = await chatModelsCache.getChatModels();
  if (allModels.length === 0) {
    return;
  }

  const claudeModels = [];
  const geminiModels = [];
  const restModels = [];
  for (const m of allModels) {
    if (m.id.toLocaleLowerCase().includes("claude")) {
      claudeModels.push(m);
    } else if (m.id.toLocaleLowerCase().includes("gemini")) {
      geminiModels.push(m);
    } else {
      restModels.push(m);
    }
  }

  // Show model selection for ANTHROPIC_MODEL
  const modelOptions = [
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
  ];

  return modelOptions;
};
