import * as vscode from "vscode";

import {
  backupExtensionFile,
  findAndRemoveHeader,
  findCopilotChatExtension,
  verifyCopilotFix,
} from "../utils/copilotFixer";
import { logger } from "../utils/logger";
import { createCommandHandler } from "./commandHandler";

export function registerCopilotFixCommands(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.fixCopilotChatModelNotSupported",
    createCommandHandler(async () => {
      // Show information about what this command does
      const proceed = await vscode.window.showWarningMessage(
        "This command will modify the GitHub Copilot Chat extension to enable additional models by removing the x-onbehalf-extension-id header. A backup will be created automatically. Do you want to proceed?",
        { modal: true },
        "Yes, Proceed",
        "No, Cancel",
      );

      if (proceed !== "Yes, Proceed") {
        return;
      }

      // Find the Copilot Chat extension
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Fixing GitHub Copilot Chat Extension",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Searching for extension..." });

          const extensionInfo = findCopilotChatExtension();

          if (!extensionInfo.found) {
            vscode.window.showErrorMessage(
              "GitHub Copilot Chat extension not found. Please ensure it is installed.",
            );
            return;
          }

          if (!extensionInfo.extensionJsPath) {
            vscode.window.showErrorMessage(
              `Found GitHub Copilot Chat extension (v${extensionInfo.version}) but extension.js file is missing. The extension may be corrupted.`,
            );
            return;
          }

          logger.info(
            `Found GitHub Copilot Chat extension: ${extensionInfo.path}`,
          );
          logger.info(`Extension version: ${extensionInfo.version}`);
          logger.info(`Extension.js path: ${extensionInfo.extensionJsPath}`);

          // Create backup
          progress.report({ message: "Creating backup..." });

          const backupResult = backupExtensionFile(
            extensionInfo.extensionJsPath,
          );

          if (!backupResult.success) {
            vscode.window.showErrorMessage(
              `Failed to create backup: ${backupResult.error}`,
            );
            return;
          }

          logger.info(`Backup created: ${backupResult.backupPath}`);

          // Apply the fix
          progress.report({ message: "Removing header..." });

          const fixResult = findAndRemoveHeader(extensionInfo.extensionJsPath);

          if (!fixResult.success) {
            vscode.window.showErrorMessage(
              `Failed to apply fix: ${fixResult.message}`,
            );
            logger.error(`Fix failed: ${fixResult.message}`);
            return;
          }

          logger.info(`Fix applied: ${fixResult.message}`);

          // Verify the fix
          progress.report({ message: "Verifying changes..." });

          const verifyResult = verifyCopilotFix(extensionInfo.extensionJsPath);

          if (!verifyResult.verified) {
            vscode.window.showWarningMessage(
              `Fix applied but verification failed: ${verifyResult.message}. Backup saved at: ${backupResult.backupPath}`,
            );
            logger.warn(`Verification failed: ${verifyResult.message}`);
            return;
          }

          logger.info("Fix verified successfully");

          // Show success message with reload prompt
          const shouldReload = await vscode.window.showInformationMessage(
            `✓ Successfully fixed GitHub Copilot Chat extension!\n\nThe x-onbehalf-extension-id header has been removed. Backup saved at:\n${backupResult.backupPath}\n\nPlease reload VS Code for the changes to take effect.`,
            "Reload Now",
            "Later",
          );

          if (shouldReload === "Reload Now") {
            await vscode.commands.executeCommand(
              "workbench.action.reloadWindow",
            );
          }
        },
      );
    }, "Failed to fix Copilot Chat extension"),
  );

  context.subscriptions.push(disposable);
}
