import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { LLM_API_KEY_SECRET_KEY } from "../utils/constant";
import { logger } from "../utils/logger";
import { createCommandHandler } from "./commandHandler";

export function registerLlmApiKeyCommands(
  proxy: ProxyServer,
  context: vscode.ExtensionContext,
) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.setLlmApiKey",
    createCommandHandler(async () => {
      const currentKey = proxy.getLlmApiKey();
      const hasKey = !!currentKey;

      const input = await vscode.window.showInputBox({
        title: "Set LLM API Key",
        prompt: hasKey
          ? "Enter a new LLM API key, or leave empty to disable authentication"
          : "Enter an LLM API key to enable authentication (leave empty to skip)",
        placeHolder: "Enter your LLM API key",
        password: true,
        ignoreFocusOut: true,
      });

      // User cancelled the input
      if (input === undefined) {
        return;
      }

      const trimmedInput = input.trim();

      if (trimmedInput === "") {
        // User wants to clear/disable the key
        proxy.setLlmApiKey(null);
        try {
          await context.secrets.delete(LLM_API_KEY_SECRET_KEY);
        } catch (error) {
          logger.error(
            "Failed to delete LLM API key from secrets storage:",
            error,
          );
          vscode.window.showWarningMessage(
            "LLM API key cleared from memory, but failed to remove from secure storage. The old key may be restored on restart.",
          );
          return;
        }
        vscode.window.showInformationMessage(
          "LLM API key has been cleared. Authentication is now disabled.",
        );
      } else {
        // User provided a key
        proxy.setLlmApiKey(trimmedInput);
        try {
          await context.secrets.store(LLM_API_KEY_SECRET_KEY, trimmedInput);
        } catch (error) {
          logger.error(
            "Failed to store LLM API key in secrets storage:",
            error,
          );
          vscode.window.showWarningMessage(
            "LLM API key set for this session, but failed to save to secure storage. The key will not persist after restart.",
          );
          return;
        }
        vscode.window.showInformationMessage(
          "LLM API key has been set. All LLM API requests now require authentication.",
        );
      }
    }, "Failed to set LLM API key"),
  );

  context.subscriptions.push(disposable);
}
