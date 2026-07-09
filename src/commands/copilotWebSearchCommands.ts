import * as vscode from "vscode";

import { CONFIG_KEYS } from "../utils/config";
import {
  getRunningCopilotBundlePath,
  listCopilotWebSearchBackups,
  patchCopilotWebSearchBundle,
  restoreCopilotWebSearchBackup,
} from "../utils/copilotWebSearchPatch";
import { logger } from "../utils/logger";
import { createCommandHandler } from "./commandHandler";

export function registerCopilotWebSearchCommands(
  context: vscode.ExtensionContext,
) {
  const patchDisposable = vscode.commands.registerCommand(
    "agent-maestro.enableExperimentalGpt5PlusWebSearch",
    createCommandHandler(async () => {
      const bundlePath = getCurrentCopilotBundlePath();

      const proceed = await vscode.window.showWarningMessage(
        `This experimental command modifies the built-in GitHub Copilot bundle for the currently running VS Code app. A backup will be created before patching.\n\nTarget:\n${bundlePath}\n\nContinue?`,
        { modal: true },
        "Patch Bundle",
      );

      if (proceed !== "Patch Bundle") {
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Enabling Experimental GPT-5+ Web Search",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Patching Copilot bundle..." });

          const result = patchCopilotWebSearchBundle(bundlePath);
          logger.info(
            `Copilot GPT-5+ web search patch status: ${result.status} (${result.bundlePath})`,
          );

          if (result.status === "already-patched") {
            await setExperimentalWebSearchEnabled(true);
            vscode.window.showInformationMessage(
              "Experimental GPT-5+ web search patch is already applied. Reloading VS Code...",
            );
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
            return;
          }

          logger.info(`Copilot bundle backup created: ${result.backupPath}`);

          await setExperimentalWebSearchEnabled(true);

          vscode.window.showInformationMessage(
            `Experimental GPT-5+ web search patch applied. Backup saved at:\n${result.backupPath}\n\nReloading VS Code...`,
          );
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        },
      );
    }, "Failed to enable experimental GPT-5+ web search"),
  );

  const restoreDisposable = vscode.commands.registerCommand(
    "agent-maestro.restoreExperimentalGpt5PlusWebSearchBackup",
    createCommandHandler(async () => {
      const bundlePath = getCurrentCopilotBundlePath();
      const backups = listCopilotWebSearchBackups(bundlePath);

      if (backups.length === 0) {
        vscode.window.showErrorMessage(
          `No Agent Maestro GPT-5+ web search backups found for:\n${bundlePath}`,
        );
        return;
      }

      const selectedBackup = await vscode.window.showQuickPick(
        backups.map((backup) => ({
          label: new Date(backup.createdAtMs).toLocaleString(),
          description: backup.path,
          backupPath: backup.path,
        })),
        {
          title: "Restore Experimental GPT-5+ Web Search Backup",
          placeHolder: "Choose a Copilot bundle backup to restore",
        },
      );

      if (!selectedBackup) {
        return;
      }

      const proceed = await vscode.window.showWarningMessage(
        `This will replace the current Copilot bundle with the selected backup and reload VS Code.\n\nTarget:\n${bundlePath}\n\nBackup:\n${selectedBackup.backupPath}\n\nContinue?`,
        { modal: true },
        "Restore Backup",
      );

      if (proceed !== "Restore Backup") {
        return;
      }

      restoreCopilotWebSearchBackup(bundlePath, selectedBackup.backupPath);
      await setExperimentalWebSearchEnabled(false);
      logger.info(
        `Restored Copilot bundle from backup: ${selectedBackup.backupPath}`,
      );

      vscode.window.showInformationMessage(
        "Experimental GPT-5+ web search backup restored. Reloading VS Code...",
      );
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }, "Failed to restore experimental GPT-5+ web search backup"),
  );

  context.subscriptions.push(patchDisposable, restoreDisposable);
}

function getCurrentCopilotBundlePath(): string {
  const copilotChatExtension = vscode.extensions.getExtension(
    "GitHub.copilot-chat",
  );

  return getRunningCopilotBundlePath({
    appRoot: vscode.env.appRoot,
    extensionPath: copilotChatExtension?.extensionPath,
    extensionMain: copilotChatExtension?.packageJSON?.main,
  });
}

async function setExperimentalWebSearchEnabled(enabled: boolean) {
  await vscode.workspace
    .getConfiguration()
    .update(
      CONFIG_KEYS.EXPERIMENTAL_GPT5_PLUS_WEB_SEARCH_ENABLED,
      enabled,
      vscode.ConfigurationTarget.Global,
    );
}
