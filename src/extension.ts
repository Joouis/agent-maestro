import * as vscode from "vscode";
import { logger } from "./utils/logger";
import { ExtensionController } from "./core/controller";
import { ProxyServer } from "./server/ProxyServer";
import { McpServer } from "./server/McpServer";
import { getSystemInfo } from "./utils/systemInfo";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  type RooVariantConfiguration,
  type AgentMaestroConfiguration,
} from "./types/config";

let controller: ExtensionController;
let proxy: ProxyServer;
let mcpServer: McpServer;
let extensionConfig: AgentMaestroConfiguration;

/**
 * Reads the current configuration from VS Code workspace settings
 */
function readConfiguration(): AgentMaestroConfiguration {
  const config = vscode.workspace.getConfiguration();

  return {
    rooVariantIdentifiers: config.get<string[]>(
      CONFIG_KEYS.ROO_VARIANT_IDENTIFIERS,
      DEFAULT_CONFIG.rooVariantIdentifiers,
    ),
    defaultRooExtensionIdentifier: config.get<string>(
      CONFIG_KEYS.DEFAULT_ROO_EXTENSION_IDENTIFIER,
      DEFAULT_CONFIG.defaultRooExtensionIdentifier,
    ),
  };
}

/**
 * Gets the current extension configuration
 */
export function getExtensionConfig(): AgentMaestroConfiguration {
  return extensionConfig || readConfiguration();
}

/**
 * Updates the extension configuration and notifies listeners
 */
function updateConfiguration(): void {
  const newConfig = readConfiguration();
  const configChanged =
    JSON.stringify(extensionConfig) !== JSON.stringify(newConfig);

  if (configChanged) {
    logger.info("Configuration updated:", newConfig);
    extensionConfig = newConfig;
    // Future: Emit configuration change event if needed
  }
}

export async function activate(context: vscode.ExtensionContext) {
  // Only show logger automatically in development mode
  const isDevMode = context.extensionMode === vscode.ExtensionMode.Development;
  if (isDevMode) {
    logger.show();
  }

  // Initialize configuration
  extensionConfig = readConfiguration();
  logger.info("Extension configuration loaded:", extensionConfig);

  // Listen for configuration changes
  const configChangeListener = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (event.affectsConfiguration("agent-maestro")) {
        updateConfiguration();
      }
    },
  );

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

  mcpServer = new McpServer({
    controller,
    port: isDevMode ? 33334 : undefined,
  });
  proxy = new ProxyServer(controller, isDevMode ? 33333 : undefined, mcpServer);

  // Register commands
  const disposables = [
    vscode.commands.registerCommand("agent-maestro.getStatus", () => {
      try {
        const systemInfo = getSystemInfo(controller, mcpServer);
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
  ];

  context.subscriptions.push(...disposables, configChangeListener);

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
