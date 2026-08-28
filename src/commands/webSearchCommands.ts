import * as vscode from "vscode";

import { EXA_API_KEY_SECRET_KEY } from "../utils/constant";
import { createCommandHandler } from "./commandHandler";

export function registerWebSearchCommands(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.setExaApiKey",
    createCommandHandler(async () => {
      const hasKey = Boolean(await context.secrets.get(EXA_API_KEY_SECRET_KEY));
      const input = await vscode.window.showInputBox({
        title: "Set Exa API Key",
        prompt: hasKey
          ? "Enter a replacement Exa API key, or leave empty to return to anonymous search"
          : "Enter an optional Exa API key, or leave empty to use anonymous search",
        placeHolder: "Exa API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (input === undefined) {
        return;
      }

      const apiKey = input.trim();
      if (apiKey) {
        await context.secrets.store(EXA_API_KEY_SECRET_KEY, apiKey);
        vscode.window.showInformationMessage(
          "Exa API key saved in VS Code SecretStorage.",
        );
      } else {
        await context.secrets.delete(EXA_API_KEY_SECRET_KEY);
        vscode.window.showInformationMessage(
          "Exa API key cleared. Web search will use anonymous Exa access.",
        );
      }
    }, "Failed to update Exa API key"),
  );

  context.subscriptions.push(disposable);
}
