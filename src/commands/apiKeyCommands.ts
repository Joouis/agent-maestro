import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { API_KEY_SECRET_KEY } from "../utils/constant";
import { createCommandHandler } from "./commandHandler";

export function registerApiKeyCommands(
  proxy: ProxyServer,
  context: vscode.ExtensionContext,
) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.setApiKey",
    createCommandHandler(async () => {
      const currentKey = proxy.getApiKey();
      const hasKey = !!currentKey;

      const input = await vscode.window.showInputBox({
        title: "Set API Key",
        prompt: hasKey
          ? "Enter a new API key, or leave empty to disable authentication"
          : "Enter an API key to enable authentication (leave empty to skip)",
        placeHolder: "Enter your API key",
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
        proxy.setApiKey(null);
        await context.secrets.delete(API_KEY_SECRET_KEY);
        vscode.window.showInformationMessage(
          "API key has been cleared. Authentication is now disabled.",
        );
      } else {
        // User provided a key
        proxy.setApiKey(trimmedInput);
        await context.secrets.store(API_KEY_SECRET_KEY, trimmedInput);
        vscode.window.showInformationMessage(
          "API key has been set. All API requests now require authentication.",
        );
      }
    }, "Failed to set API key"),
  );

  context.subscriptions.push(disposable);
}
