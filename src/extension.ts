import * as vscode from "vscode";

import { registerAllCommands } from "./commands";
import { ExtensionController } from "./core/controller";
import { McpServer } from "./server/McpServer";
import { ProxyServer } from "./server/ProxyServer";
import { chatModelsCache } from "./utils/chatModels";
import { performClaudeCodeSelfCheck } from "./utils/claude";
import { CONFIG_KEYS, readConfiguration } from "./utils/config";
import { checkCopilotPromptCacheSetting } from "./utils/copilotPromptCache";
import { logger } from "./utils/logger";

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

  // Perform self-check to add additional settings for seamless Claude Code native extension compatibility
  performClaudeCodeSelfCheck();

  // Not awaited: the notification must not block activation.
  void checkCopilotPromptCacheSetting(context);

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

  const proxyPort = envProxyPort ? envProxyPort : config.proxyServerPort;
  proxy = new ProxyServer(controller, proxyPort, context);

  mcpServer = new McpServer({
    controller,
    port: envMcpPort ? envMcpPort : config.mcpServerPort,
    getApiKeys: () => proxy.getApiKeys(),
  });

  // Watch before the first read so a change made by another window during
  // the read is not missed. Keys must be loaded before either server starts.
  context.subscriptions.push(proxy.watchApiKeySecrets());
  await proxy.restoreApiKeys();
  proxy.onApiKeysChanged(
    () => void mcpServer.restartIfRunning("API keys changed"),
  );

  // Register all commands
  registerAllCommands(context, controller, proxy, mcpServer);

  await vscode.commands.executeCommand("agent-maestro.startProxyServer");
  await vscode.commands.executeCommand("agent-maestro.startMcpServer");

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(CONFIG_KEYS.PROXY_SERVER_CORS_ORIGINS) ||
        event.affectsConfiguration(CONFIG_KEYS.MCP_SERVER_CORS_ORIGINS)
      ) {
        proxy.warnIfWildcardWithoutKeys();
      }
      // MCP checks origins only when a session opens; restart so sessions
      // from a newly removed origin cannot keep calling tools.
      if (event.affectsConfiguration(CONFIG_KEYS.MCP_SERVER_CORS_ORIGINS)) {
        void mcpServer.restartIfRunning("MCP origin allowlist changed");
      }
    }),
  );

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
