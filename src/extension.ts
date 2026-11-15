import * as vscode from "vscode";

import { registerAllCommands } from "./commands";
import { ProxyServer } from "./server/ProxyServer";
import { chatModelsCache } from "./utils/chatModels";
import { performClaudeCodeSelfCheck } from "./utils/claude";
import { CONFIG_KEYS, readConfiguration } from "./utils/config";
import { checkCopilotPromptCacheSetting } from "./utils/copilotPromptCache";
import { logger } from "./utils/logger";

let proxy: ProxyServer;

const envProxyPort = process.env.AGENT_MAESTRO_PROXY_PORT
  ? parseInt(process.env.AGENT_MAESTRO_PROXY_PORT, 10)
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

  // Initialize chat models cache
  chatModelsCache.initialize();

  const config = readConfiguration();
  const proxyPort = envProxyPort ? envProxyPort : config.proxyServerPort;
  proxy = new ProxyServer(proxyPort, context);

  // Watch before the first read so a change made by another window during
  // the read is not missed. Keys must be loaded before the server starts.
  context.subscriptions.push(proxy.watchApiKeySecrets());
  await proxy.restoreApiKeys();

  registerAllCommands(context, proxy);

  await vscode.commands.executeCommand("agent-maestro.startProxyServer");

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_KEYS.PROXY_SERVER_CORS_ORIGINS)) {
        proxy.warnIfWildcardWithoutKeys();
      }
    }),
  );
}

// This method is called when your extension is deactivated
export async function deactivate() {
  try {
    if (proxy) {
      await proxy.stop();
      logger.info("Proxy server stopped");
    }
  } catch (error) {
    logger.error("Error during deactivation:", error);
  }
}
