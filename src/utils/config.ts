import * as vscode from "vscode";

export interface AgentMaestroConfiguration {
  rooVariantIdentifiers: string[];
  defaultRooIdentifier: string;
  proxyServerPort: number;
  mcpServerPort: number;
  allowOutsideWorkspaceAccess: boolean;
  experimentalGpt5PlusWebSearchEnabled: boolean;
}

/**
 * Configuration keys used in VS Code workspace configuration
 */
export const CONFIG_KEYS = {
  ROO_VARIANT_IDENTIFIERS: "agent-maestro.rooVariantIdentifiers",
  DEFAULT_ROO_IDENTIFIER: "agent-maestro.defaultRooIdentifier",
  PROXY_SERVER_PORT: "agent-maestro.proxyServerPort",
  MCP_SERVER_PORT: "agent-maestro.mcpServerPort",
  ALLOW_OUTSIDE_WORKSPACE_ACCESS: "agent-maestro.allowOutsideWorkspaceAccess",
  EXPERIMENTAL_GPT5_PLUS_WEB_SEARCH_ENABLED:
    "agent-maestro.experimentalGpt5PlusWebSearchEnabled",
} as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AgentMaestroConfiguration = {
  rooVariantIdentifiers: ["kilocode.kilo-code"],
  defaultRooIdentifier: "rooveterinaryinc.roo-cline",
  proxyServerPort: 23333,
  mcpServerPort: 23334,
  allowOutsideWorkspaceAccess: false,
  experimentalGpt5PlusWebSearchEnabled: false,
};

/**
 * Reads the current configuration from VS Code workspace settings
 */
export const readConfiguration = (): AgentMaestroConfiguration => {
  const config = vscode.workspace.getConfiguration();

  return {
    rooVariantIdentifiers: config.get<string[]>(
      CONFIG_KEYS.ROO_VARIANT_IDENTIFIERS,
      DEFAULT_CONFIG.rooVariantIdentifiers,
    ),
    defaultRooIdentifier: config.get<string>(
      CONFIG_KEYS.DEFAULT_ROO_IDENTIFIER,
      DEFAULT_CONFIG.defaultRooIdentifier,
    ),
    proxyServerPort: config.get<number>(
      CONFIG_KEYS.PROXY_SERVER_PORT,
      DEFAULT_CONFIG.proxyServerPort,
    ),
    mcpServerPort: config.get<number>(
      CONFIG_KEYS.MCP_SERVER_PORT,
      DEFAULT_CONFIG.mcpServerPort,
    ),
    allowOutsideWorkspaceAccess: config.get<boolean>(
      CONFIG_KEYS.ALLOW_OUTSIDE_WORKSPACE_ACCESS,
      DEFAULT_CONFIG.allowOutsideWorkspaceAccess,
    ),
    experimentalGpt5PlusWebSearchEnabled: config.get<boolean>(
      CONFIG_KEYS.EXPERIMENTAL_GPT5_PLUS_WEB_SEARCH_ENABLED,
      DEFAULT_CONFIG.experimentalGpt5PlusWebSearchEnabled,
    ),
  };
};
