import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { generateApiKey, validateAdminApiKey } from "../utils/apiKeys";
import { ADMIN_API_KEY_SECRET_KEY } from "../utils/constant";
import { logger } from "../utils/logger";
import { confirmDistinctFromOtherKey } from "./apiKeyPrompts";
import { createCommandHandler } from "./commandHandler";

type Action = "generate" | "enter" | "clear";

export function registerAdminApiKeyCommands(
  proxy: ProxyServer,
  context: vscode.ExtensionContext,
) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.setAdminApiKey",
    createCommandHandler(async () => {
      const hasKey = proxy.getApiKeys().admin.status !== "unset";
      const items: (vscode.QuickPickItem & { action: Action })[] = [
        {
          label: "Generate a random key",
          description: "(Recommended)",
          action: "generate",
        },
        { label: "Enter a key manually", action: "enter" },
      ];
      if (hasKey) {
        items.push({ label: "Clear the key", action: "clear" });
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: "Set Admin API Key",
        placeHolder:
          "The Admin API Key grants every route, including file, workspace, and model-discovery routes under /api/v1",
        ignoreFocusOut: true,
      });
      if (!picked) {
        return;
      }

      if (picked.action === "clear") {
        // Delete from storage first: if that fails, keep enforcing the key
        // rather than leaving memory and storage out of sync.
        try {
          await context.secrets.delete(ADMIN_API_KEY_SECRET_KEY);
        } catch (error) {
          logger.error("Failed to delete Admin API key from secrets:", error);
          vscode.window.showErrorMessage(
            "Failed to remove the Admin API key from secure storage. The key is still active.",
          );
          return;
        }
        // Re-read instead of forcing unset: if another window stored a new key
        // after this delete, that newer key must stay in effect.
        await proxy.refreshApiKey("admin");
        const admin = proxy.getApiKeys().admin;
        if (admin.status === "locked") {
          vscode.window.showErrorMessage(
            "The Admin API key was deleted, but secure storage could not be read to confirm it. Routes it protects return 503 until you set the key again.",
          );
        } else if (admin.status === "set") {
          vscode.window.showWarningMessage(
            "The Admin API key was deleted, but another window has since set a new one. That key is still active.",
          );
        } else {
          vscode.window.showInformationMessage(
            "Admin API key has been cleared.",
          );
        }
        return;
      }

      let key: string;
      if (picked.action === "generate") {
        key = generateApiKey();
      } else {
        const input = await vscode.window.showInputBox({
          title: "Set Admin API Key",
          prompt:
            "Enter an Admin API key of at least 16 printable ASCII characters with no spaces.",
          password: true,
          ignoreFocusOut: true,
          validateInput: validateAdminApiKey,
        });
        if (input === undefined) {
          return;
        }
        key = input;
      }

      if (!(await confirmDistinctFromOtherKey(key, proxy.getLlmApiKey()))) {
        return;
      }

      proxy.setAdminApiKey(key);
      try {
        await context.secrets.store(ADMIN_API_KEY_SECRET_KEY, key);
      } catch (error) {
        logger.error("Failed to store Admin API key in secrets:", error);
        vscode.window.showWarningMessage(
          "Admin API key set for this session, but failed to save to secure storage. The key will not persist after restart.",
        );
      }

      if (picked.action === "generate") {
        await vscode.env.clipboard.writeText(key);
        const copy = "Copy Again";
        const choice = await vscode.window.showInformationMessage(
          "A new Admin API key was generated and copied to the clipboard. It will not be shown again; generate a new one if it is lost.",
          copy,
        );
        if (choice === copy) {
          await vscode.env.clipboard.writeText(key);
        }
      } else {
        vscode.window.showInformationMessage(
          "Admin API key has been set. All routes now accept it, and /api/v1 requires it.",
        );
      }
    }, "Failed to set Admin API key"),
  );

  context.subscriptions.push(disposable);
}
