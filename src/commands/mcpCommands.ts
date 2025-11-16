import * as vscode from "vscode";

import { McpServer } from "../server/McpServer";
import { ANOTHER_INSTANCE_RUNNING_MESSAGE } from "../utils/constant";
import { logger } from "../utils/logger";
import {
  addAgentMaestroMcpConfig,
  getAvailableExtensions,
} from "../utils/mcpConfig";
import { createCommandHandler } from "./commandHandler";

export function registerMcpCommands(
  mcpServer: McpServer,
  context: vscode.ExtensionContext,
) {
  const disposables = [
    vscode.commands.registerCommand(
      "agent-maestro.startMcpServer",
      createCommandHandler(async () => {
        const result = await mcpServer.start();

        if (result.started) {
          vscode.window.showInformationMessage(
            `Agent Maestro MCP Server started successfully on port ${result.port}`,
          );
        } else {
          // Don't show error message for "another instance running" case
          if (result.reason === ANOTHER_INSTANCE_RUNNING_MESSAGE) {
            logger.info(`MCP server startup skipped: ${result.reason}`);
          } else {
            vscode.window.showInformationMessage(
              `MCP Server startup: ${result.reason}`,
            );
          }
        }
      }, "Failed to start MCP server"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.stopMcpServer",
      createCommandHandler(async () => {
        if (!mcpServer) {
          vscode.window.showErrorMessage("MCP server not initialized");
          return;
        }

        await mcpServer.stop();
        vscode.window.showInformationMessage("MCP server stopped");
      }, "Failed to stop MCP server"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.getMcpServerStatus",
      createCommandHandler(() => {
        if (!mcpServer) {
          vscode.window.showErrorMessage("MCP server not initialized");
          return;
        }

        const status = mcpServer.getStatus();
        vscode.window.showInformationMessage(
          `MCP Server Status: ${status.isRunning ? "Running" : "Stopped"} | Port: ${status.port} | URL: ${status.url}`,
        );
      }, "Failed to get MCP server status"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.installMcpConfig",
      createCommandHandler(async () => {
        // Get available extensions (only installed ones)
        const availableExtensions = getAvailableExtensions();

        if (availableExtensions.length === 0) {
          vscode.window.showErrorMessage(
            "No supported extensions found for MCP configuration. Please ensure you have Roo Code or Kilo Code extensions installed.",
          );
          return;
        }

        // Create quick pick items with display names from installed extensions
        const quickPickItems = availableExtensions.map((extension) => ({
          label: extension.displayName,
          description: extension.id,
          detail: `Install Agent Maestro MCP configuration for ${extension.displayName}`,
          extensionId: extension.id,
        }));

        // Show quick pick dialog
        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
          title: "Select Extension for MCP Configuration",
          placeHolder:
            "Choose which extension to configure with Agent Maestro MCP server",
          canPickMany: false,
        });

        if (!selectedItem) {
          // User cancelled the selection
          return;
        }

        // Show progress during configuration
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Installing MCP Configuration",
            cancellable: false,
          },
          async (progress) => {
            progress.report({
              message: `Configuring ${selectedItem.label}...`,
            });

            // Add the MCP configuration
            const result = await addAgentMaestroMcpConfig({
              extensionId: selectedItem.extensionId,
              globalStorageUri: context.globalStorageUri,
            });

            if (result.success) {
              vscode.window.showInformationMessage(
                `Successfully installed Agent Maestro MCP configuration for ${selectedItem.label}. The extension can now access Agent Maestro tools and resources.`,
              );
              logger.info(
                `MCP configuration installed for ${selectedItem.extensionId}: ${result.configPath}`,
              );
            } else {
              if (result.message.includes("already exists")) {
                vscode.window.showInformationMessage(
                  `Agent Maestro MCP configuration already exists for ${selectedItem.label}. No changes were made.`,
                );
              } else {
                vscode.window.showErrorMessage(
                  `Failed to install MCP configuration for ${selectedItem.label}: ${result.message}`,
                );
              }
            }
          },
        );
      }, "Error installing MCP configuration"),
    ),
  ];

  context.subscriptions.push(...disposables);
}
