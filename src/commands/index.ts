import * as vscode from "vscode";

import { ExtensionController } from "../core/controller";
import { McpServer } from "../server/McpServer";
import { ProxyServer } from "../server/ProxyServer";
import { registerConfiguratorCommands } from "./configuratorCommands";
import { registerCopilotWebSearchCommands } from "./copilotWebSearchCommands";
import { registerLlmApiKeyCommands } from "./llmApiKeyCommands";
import { registerMcpCommands } from "./mcpCommands";
import { registerProxyCommands } from "./proxyCommands";
import { registerStatusCommands } from "./statusCommands";

export function registerAllCommands(
  context: vscode.ExtensionContext,
  controller: ExtensionController,
  proxy: ProxyServer,
  mcpServer: McpServer,
) {
  registerProxyCommands(proxy, context);
  registerMcpCommands(mcpServer, context);
  registerConfiguratorCommands(proxy, context);
  registerCopilotWebSearchCommands(context);
  registerStatusCommands(controller, context);
  registerLlmApiKeyCommands(proxy, context);
}
