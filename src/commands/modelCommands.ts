import * as vscode from "vscode";

import { getChatModelsQuickPickItems } from "../utils/chatModels";
import { DEFAULT_CONFIG } from "../utils/config";
import { createCommandHandler } from "./commandHandler";

export function registerModelCommands(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.selectFallbackModel",
    createCommandHandler(async () => {
      const configuration = vscode.workspace.getConfiguration("agent-maestro");
      const currentModelId = configuration
        .get<string>("fallbackModelId", DEFAULT_CONFIG.fallbackModelId)
        .trim();
      const modelOptions = await getChatModelsQuickPickItems();
      if (modelOptions.length === 0) {
        vscode.window.showErrorMessage(
          "No available chat model provided by VS Code LM API.",
        );
        return;
      }
      const selectedModel = await vscode.window.showQuickPick(modelOptions, {
        title: "Select Fallback Model",
        placeHolder: currentModelId
          ? `Current fallback: ${currentModelId}`
          : "Choose a fallback model for unknown model IDs",
      });

      if (
        !selectedModel ||
        ("kind" in selectedModel &&
          selectedModel.kind === vscode.QuickPickItemKind.Separator)
      ) {
        return;
      }

      await configuration.update(
        "fallbackModelId",
        selectedModel.modelId,
        vscode.ConfigurationTarget.Global,
      );
      vscode.window.showInformationMessage(
        `Fallback model set to ${selectedModel.modelId}.`,
      );
    }, "Failed to select fallback model"),
  );

  context.subscriptions.push(disposable);
}
