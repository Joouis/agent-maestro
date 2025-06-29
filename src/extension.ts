import * as vscode from "vscode";
import { logger } from "./utils/logger";
import { ExtensionController } from "./core/controller";
import { ProxyServer } from "./server/ProxyServer";
import { McpServer } from "./server/McpServer";
import { getSystemInfo } from "./utils/systemInfo";
import {
  getAvailableExtensions,
  addAgentMaestroMcpConfig,
} from "./utils/mcpConfig";

let controller: ExtensionController;
let proxy: ProxyServer;
let mcpServer: McpServer;

export async function activate(context: vscode.ExtensionContext) {
  // Only show logger automatically in development mode
  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  if (isDevMode) {
    logger.show();
  }

  // Initialize the extension controller
  controller = new ExtensionController();

  try {
    await controller.initialize();
  } catch (error) {
    logger.error("Failed to initialize extension controller:", error);
    vscode.window.showErrorMessage(
      `Agent Maestro: Failed to initialize - ${(error as Error).message}`,
    );
  }

  try {
    mcpServer = new McpServer({
      controller,
      port: isDevMode ? 33334 : undefined,
    });
  } catch (error) {
    logger.error("Failed to initialize MCP server:", error);
  }

  proxy = new ProxyServer(controller, isDevMode ? 33333 : undefined, context);

  // Register commands
  const disposables = [
    vscode.commands.registerCommand("agent-maestro.getStatus", () => {
      try {
        const systemInfo = getSystemInfo(controller);
        vscode.window.showInformationMessage(
          JSON.stringify(systemInfo, null, 2),
        );
      } catch (error) {
        logger.error("Error retrieving system information:", error);
        vscode.window.showErrorMessage(
          `Failed to get system status: ${(error as Error).message}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "agent-maestro.startProxyServer",
      async () => {
        try {
          if (!proxy) {
            vscode.window.showErrorMessage("Proxy server not initialized");
            return;
          }

          const result = await proxy.start();

          if (result.started) {
            vscode.window.showInformationMessage(
              `Agent Maestro server started successfully. View API documentation at ${proxy.getOpenAPIUrl()}`,
            );
          } else {
            // Don't show error message for "another instance running" case
            if (result.reason === "Another instance is already running") {
              logger.info(`Server startup skipped: ${result.reason}`);
            } else {
              vscode.window.showInformationMessage(
                `Server startup: ${result.reason}`,
              );
            }
          }
        } catch (error) {
          logger.error("Failed to start server:", error);
          vscode.window.showErrorMessage(
            `Failed to start server: ${(error as Error).message}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "agent-maestro.stopProxyServer",
      async () => {
        try {
          if (!proxy) {
            vscode.window.showErrorMessage("Proxy server not initialized");
            return;
          }

          await proxy.stop();
          vscode.window.showInformationMessage("Proxy server stopped");
        } catch (error) {
          logger.error("Failed to stop server:", error);
          vscode.window.showErrorMessage(
            `Failed to stop server: ${(error as Error).message}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "agent-maestro.restartProxyServer",
      async () => {
        try {
          if (!proxy) {
            vscode.window.showErrorMessage("Proxy server not initialized");
            return;
          }

          await proxy.stop();
          const result = await proxy.start();

          if (result.started) {
            const status = proxy.getStatus();
            vscode.window.showInformationMessage(
              `Proxy server restarted on ${status.url}`,
            );
          } else {
            vscode.window.showInformationMessage(
              `Server restart: ${result.reason}`,
            );
          }
        } catch (error) {
          logger.error("Failed to restart server:", error);
          vscode.window.showErrorMessage(
            `Failed to restart server: ${(error as Error).message}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "agent-maestro.getProxyServerStatus",
      () => {
        if (!proxy) {
          vscode.window.showErrorMessage("Proxy server not initialized");
          return;
        }

        const status = proxy.getStatus();
        vscode.window.showInformationMessage(
          `Server Status: ${status.isRunning ? "Running" : "Stopped"} | Port: ${status.port} | URL: ${status.url}`,
        );
      },
    ),

    vscode.commands.registerCommand(
      "agent-maestro.startMcpServer",
      async () => {
        try {
          if (!mcpServer) {
            vscode.window.showErrorMessage("MCP server not initialized");
            return;
          }

          const result = await mcpServer.start();

          if (result.started) {
            vscode.window.showInformationMessage(
              `MCP Server started successfully on port ${result.port}`,
            );
          } else {
            vscode.window.showInformationMessage(
              `MCP Server startup: ${result.reason}`,
            );
          }
        } catch (error) {
          logger.error("Failed to start MCP server:", error);
          vscode.window.showErrorMessage(
            `Failed to start MCP server: ${(error as Error).message}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand("agent-maestro.stopMcpServer", async () => {
      try {
        if (!mcpServer) {
          vscode.window.showErrorMessage("MCP server not initialized");
          return;
        }

        await mcpServer.stop();
        vscode.window.showInformationMessage("MCP server stopped");
      } catch (error) {
        logger.error("Failed to stop MCP server:", error);
        vscode.window.showErrorMessage(
          `Failed to stop MCP server: ${(error as Error).message}`,
        );
      }
    }),

    vscode.commands.registerCommand("agent-maestro.getMcpServerStatus", () => {
      if (!mcpServer) {
        vscode.window.showErrorMessage("MCP server not initialized");
        return;
      }

      const status = mcpServer.getStatus();
      vscode.window.showInformationMessage(
        `MCP Server Status: ${status.isRunning ? "Running" : "Stopped"} | Port: ${status.port} | URL: ${status.url}`,
      );
    }),

    vscode.commands.registerCommand(
      "agent-maestro.installMcpConfig",
      async () => {
        try {
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
          const selectedItem = await vscode.window.showQuickPick(
            quickPickItems,
            {
              title: "Select Extension for MCP Configuration",
              placeHolder:
                "Choose which extension to configure with Agent Maestro MCP server",
              canPickMany: false,
            },
          );

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
        } catch (error) {
          logger.error("Error installing MCP configuration:", error);
          vscode.window.showErrorMessage(
            `Failed to install MCP configuration: ${(error as Error).message}`,
          );
        }
      },
    ),
  ];

  context.subscriptions.push(...disposables);

  await vscode.commands.executeCommand("agent-maestro.startProxyServer");
  await vscode.commands.executeCommand("agent-maestro.startMcpServer");

  return controller;
}

// This method is called when your extension is deactivated
export async function deactivate() {
  try {
    if (mcpServer) {
      await mcpServer.stop();
      logger.info("MCP server stopped");
    }
    if (proxy) {
      await proxy.stop();
      logger.info("Proxy server stopped");
    }
    if (controller) {
      await controller.dispose();
      logger.info("Extension controller disposed");
    }
  } catch (error) {
    logger.error("Error during deactivation:", error);
  }
}
