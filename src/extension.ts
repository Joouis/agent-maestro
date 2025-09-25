import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { ExtensionController } from "./core/controller";
import { McpServer } from "./server/McpServer";
import { ProxyServer } from "./server/ProxyServer";
import {
  chatModelsCache,
  getChatModelsQuickPickItems,
} from "./utils/chatModels";
import { readConfiguration } from "./utils/config";
import { logger } from "./utils/logger";
import {
  addAgentMaestroMcpConfig,
  getAvailableExtensions,
} from "./utils/mcpConfig";
import { getSystemInfo } from "./utils/systemInfo";

let controller: ExtensionController;
let proxy: ProxyServer;
let mcpServer: McpServer;

const envProxyPort = process.env.AGENT_MAESTRO_PROXY_PORT
  ? parseInt(process.env.AGENT_MAESTRO_PROXY_PORT, 10)
  : undefined;
const envMcpPort = process.env.AGENT_MAESTRO_MCP_PORT
  ? parseInt(process.env.AGENT_MAESTRO_MCP_PORT, 10)
  : undefined;

export async function activate(context: vscode.ExtensionContext) {
  // Only show logger automatically in development mode
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    logger.show();
  }

  // Initialize the extension controller
  controller = new ExtensionController();

  // Initialize chat models cache
  chatModelsCache.initialize();

  try {
    await controller.initialize();
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to initialize extension controller: ${(error as Error).message}`,
    );
  }

  // Get configuration
  const config = readConfiguration();

  mcpServer = new McpServer({
    controller,
    port: envMcpPort ? envMcpPort : config.mcpServerPort,
  });

  const proxyPort = envProxyPort ? envProxyPort : config.proxyServerPort;
  proxy = new ProxyServer(controller, proxyPort, context);

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
              `Agent Maestro proxy server started successfully. View API documentation at ${proxy.getOpenApiUrl()}`,
            );
          } else {
            // Don't show error message for "another instance running" case
            if (result.reason === "Another instance is already running") {
              logger.info(`Proxy server startup skipped: ${result.reason}`);
            } else {
              vscode.window.showInformationMessage(
                `Proxy server startup: ${result.reason}`,
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
          const result = await mcpServer.start();

          if (result.started) {
            vscode.window.showInformationMessage(
              `Agent Maestro MCP Server started successfully on port ${result.port}`,
            );
          } else {
            // vscode.window.showInformationMessage(
            //   `MCP Server startup: ${result.reason}`,
            // );
            logger.error(`MCP Server startup failed: ${result.reason}`);
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

    vscode.commands.registerCommand(
      "agent-maestro.configureClaudeCode",
      async () => {
        try {
          // Ask user whether to configure user settings or project settings
          const settingsType = await vscode.window.showQuickPick(
            [
              {
                label: "User Settings",
                description:
                  "Personal global settings for all projects (~/.claude/settings.json)",
              },
              {
                label: "Project Settings",
                description:
                  "Team-shared project settings in source control (.claude/settings.json)",
              },
            ],
            {
              title: "Configure Claude Code Settings",
              placeHolder: "Choose where to save Claude Code settings",
            },
          );

          if (!settingsType) {
            return;
          }

          let claudeDir: vscode.Uri;
          let settingsFile: vscode.Uri;

          if (settingsType.label === "User Settings") {
            // Use user's home directory
            const homePath = os.homedir();
            claudeDir = vscode.Uri.file(homePath).with({
              path: homePath + "/.claude",
            });
            settingsFile = vscode.Uri.joinPath(claudeDir, "settings.json");
          } else {
            // Use project directory
            const workspaceRoot =
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
              vscode.window.showErrorMessage(
                "No workspace folder found. Please open a workspace to configure project Claude Code settings.",
              );
              return;
            }

            claudeDir = vscode.Uri.joinPath(
              vscode.Uri.file(workspaceRoot),
              ".claude",
            );
            settingsFile = vscode.Uri.joinPath(claudeDir, "settings.json");
          }

          // Check if settings file exists and confirm override
          let existingSettings: any = {};
          let fileExists = false;
          try {
            const settingsContent =
              await vscode.workspace.fs.readFile(settingsFile);
            existingSettings = JSON.parse(settingsContent.toString());
            fileExists = true;

            const shouldOverride = await vscode.window.showQuickPick(
              ["Yes", "No"],
              {
                title: "Claude Code Settings Found",
                placeHolder:
                  "Settings file already exists. Do you want to update it?",
              },
            );

            if (shouldOverride !== "Yes") {
              return;
            }
          } catch (error) {
            // File doesn't exist, continue with creation
          }

          const modelOptions = await getChatModelsQuickPickItems();

          if (modelOptions.length === 0) {
            vscode.window.showErrorMessage(
              "No available chat model provided by VS Code LM API.",
            );
            return;
          }

          const selectedMainModel = await vscode.window.showQuickPick(
            modelOptions,
            {
              title: "Select main model (ANTHROPIC_MODEL)",
              placeHolder: "Name of custom model to use",
            },
          );

          if (!selectedMainModel?.modelId) {
            return;
          }

          const selectedFastModel = await vscode.window.showQuickPick(
            modelOptions,
            {
              title: "Select small fast model (ANTHROPIC_SMALL_FAST_MODEL)",
              placeHolder: "Name of Haiku-class model for background tasks",
            },
          );

          if (!selectedFastModel?.modelId) {
            return;
          }

          // Preserve existing auth token if it has a meaningful value
          const currentToken = existingSettings?.env?.ANTHROPIC_AUTH_TOKEN;
          const authToken = currentToken
            ? currentToken
            : "Powered by Agent Maestro";

          // Create new settings
          const newSettings = {
            ...existingSettings,
            env: {
              ...existingSettings?.env,
              ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}/api/anthropic`,
              ANTHROPIC_AUTH_TOKEN: authToken,
              ANTHROPIC_MODEL: selectedMainModel.modelId,
              ANTHROPIC_SMALL_FAST_MODEL: selectedFastModel.modelId,
              // Equivalent of setting `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_ERROR_REPORTING`, and `DISABLE_TELEMETRY` to true
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            },
          };

          // Ensure .claude directory exists
          try {
            await vscode.workspace.fs.createDirectory(claudeDir);
          } catch (error) {
            // Directory might already exist, ignore error
          }

          // Write settings file
          await vscode.workspace.fs.writeFile(
            settingsFile,
            Buffer.from(JSON.stringify(newSettings, null, 2)),
          );

          vscode.window.showInformationMessage(
            `Claude Code settings ${fileExists ? "updated" : "created"} successfully! The settings point to Agent Maestro proxy server for Anthropic-compatible API.`,
          );

          logger.info(
            `Claude Code settings ${fileExists ? "updated" : "created"}: ${settingsFile.fsPath}`,
          );
        } catch (error) {
          logger.error("Error configuring Claude Code settings:", error);
          vscode.window.showErrorMessage(
            `Failed to configure Claude Code settings: ${(error as Error).message}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "agent-maestro.configureCodex",
      async () => {
        try {
          const codexConfigPath = `${os.homedir()}/.codex/config.toml`;

          // Check if config file exists and confirm override
          let fileExists = false;
          try {
            fs.accessSync(codexConfigPath);
            fileExists = true;

            const shouldOverride = await vscode.window.showQuickPick(
              ["Yes", "No"],
              {
                title: "Codex Configuration Found",
                placeHolder:
                  "Config file already exists. Do you want to update it?",
              },
            );

            if (shouldOverride !== "Yes") {
              return;
            }
          } catch (error) {
            // File doesn't exist, continue with creation
          }

          const modelOptions = await getChatModelsQuickPickItems("gpt-5-codex");

          if (modelOptions.length === 0) {
            vscode.window.showErrorMessage(
              "No available chat model provided by VS Code LM API.",
            );
            return;
          }

          const selectedModel = await vscode.window.showQuickPick(
            modelOptions,
            {
              title: "Select model",
              placeHolder: "Choose which model to use with Codex",
            },
          );

          if (!selectedModel?.modelId) {
            return;
          }

          // Create config content
          const configContent = `# Set the default model and provider
model = "${selectedModel.modelId}"
model_provider = "agent-maestro"

# Configure the Agent Maestro provider
[model_providers.agent-maestro]
name = "Agent Maestro"
base_url = "http://localhost:${proxyPort}/api/openai"
wire_api = "chat"
`;

          // Ensure .codex directory exists
          const codexDir = path.dirname(codexConfigPath);

          try {
            fs.mkdirSync(codexDir, { recursive: true });
          } catch (error) {
            // Directory might already exist, ignore error
          }

          // Write config file
          fs.writeFileSync(codexConfigPath, configContent);

          vscode.window.showInformationMessage(
            `Codex configuration ${fileExists ? "updated" : "created"} successfully! The configuration points to Agent Maestro proxy server for OpenAI-compatible API.`,
          );

          logger.info(
            `Codex configuration ${fileExists ? "updated" : "created"}: ${codexConfigPath}`,
          );
        } catch (error) {
          logger.error("Error configuring Codex settings:", error);
          vscode.window.showErrorMessage(
            `Failed to configure Codex settings: ${(error as Error).message}`,
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
