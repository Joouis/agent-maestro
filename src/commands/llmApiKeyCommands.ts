import * as vscode from "vscode";

import {
  HttpAuthentication,
  validateApiKey,
} from "../server/httpAuthentication";
import { LLM_API_KEY_SECRET_KEY } from "../utils/constant";
import { createCommandHandler } from "./commandHandler";

export function registerLlmApiKeyCommands(
  authentication: HttpAuthentication,
  context: vscode.ExtensionContext,
): void {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.setLlmApiKey",
    createCommandHandler(async () => {
      const status = await authentication.getStatus();
      const choices: Array<
        vscode.QuickPickItem & { action: "set" | "disable" | "import" }
      > = [
        {
          label: "Set or replace API key",
          description: "Protect control and LLM APIs for this OS user",
          action: "set",
        },
        {
          label: "Disable HTTP authentication",
          description: "Allow requests without a key in a trusted environment",
          action: "disable",
        },
      ];
      if (status === "unavailable") {
        choices.push({
          label: "Import previous LLM API key",
          description: "Read the old key from VS Code secure storage",
          action: "import",
        });
      }
      const choice = await vscode.window.showQuickPick(choices, {
        title: "Agent Maestro: Set API Key",
        placeHolder:
          "Shared by all AM windows and VS Code installations for this OS user",
        ignoreFocusOut: true,
      });
      if (!choice) {
        return;
      }

      let key: string | null;
      if (choice.action === "disable") {
        const confirmed = await vscode.window.showWarningMessage(
          "Disable HTTP authentication?",
          {
            modal: true,
            detail:
              "This allows any client that can reach the HTTP port to use file, workspace, task, and LLM APIs without a key. The server listens on all network interfaces. This change applies to all Agent Maestro windows and VS Code installations for this OS user.",
          },
          "Disable authentication",
        );
        if (confirmed !== "Disable authentication") {
          return;
        }
        key = null;
      } else if (choice.action === "import") {
        key = (await context.secrets.get(LLM_API_KEY_SECRET_KEY))?.trim() ?? "";
        if (validateApiKey(key)) {
          throw new Error(
            "The previous key could not be recovered. Use Set or replace API key.",
          );
        }
      } else {
        const input = await vscode.window.showInputBox({
          title: "Set API Key",
          prompt: "Choose a strong key and use the same key in your clients.",
          password: true,
          ignoreFocusOut: true,
          validateInput: validateApiKey,
        });
        if (input === undefined) {
          return;
        }
        key = input;
      }

      await authentication.configure(key);
      void vscode.window.showInformationMessage(
        key === null
          ? "HTTP authentication is disabled for this OS user. New requests in all AM windows use this policy."
          : "API key saved. New control and LLM requests in all AM windows require this key. Configure the same key in your clients.",
      );
    }, "Failed to configure HTTP authentication"),
  );
  context.subscriptions.push(disposable);
}
