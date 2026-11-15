import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { registerAdminApiKeyCommands } from "./adminApiKeyCommands";
import { registerConfiguratorCommands } from "./configuratorCommands";
import { registerLlmApiKeyCommands } from "./llmApiKeyCommands";
import { registerModelCommands } from "./modelCommands";
import { registerProxyCommands } from "./proxyCommands";
import { registerWebSearchCommands } from "./webSearchCommands";

export function registerAllCommands(
  context: vscode.ExtensionContext,
  proxy: ProxyServer,
) {
  registerProxyCommands(proxy, context);
  registerConfiguratorCommands(proxy, context);
  registerModelCommands(context);
  registerLlmApiKeyCommands(proxy, context);
  registerAdminApiKeyCommands(proxy, context);
  registerWebSearchCommands(context);
}
