import * as vscode from "vscode";

export interface AgentMaestroConfiguration {
  proxyServerPort: number;
  allowOutsideWorkspaceAccess: boolean;
  fallbackModelId: string;
  proxyServerCorsOrigins: string[];
}

/**
 * Configuration keys used in VS Code workspace configuration
 */
export const CONFIG_KEYS = {
  PROXY_SERVER_PORT: "agent-maestro.proxyServerPort",
  ALLOW_OUTSIDE_WORKSPACE_ACCESS: "agent-maestro.allowOutsideWorkspaceAccess",
  FALLBACK_MODEL_ID: "agent-maestro.fallbackModelId",
  PROXY_SERVER_CORS_ORIGINS: "agent-maestro.proxyServerCorsOrigins",
} as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AgentMaestroConfiguration = {
  proxyServerPort: 23333,
  allowOutsideWorkspaceAccess: false,
  fallbackModelId: "",
  proxyServerCorsOrigins: [],
};

/**
 * Reads the current configuration from VS Code workspace settings
 */
export const readConfiguration = (): AgentMaestroConfiguration => {
  const config = vscode.workspace.getConfiguration();

  return {
    proxyServerPort: config.get<number>(
      CONFIG_KEYS.PROXY_SERVER_PORT,
      DEFAULT_CONFIG.proxyServerPort,
    ),
    allowOutsideWorkspaceAccess: config.get<boolean>(
      CONFIG_KEYS.ALLOW_OUTSIDE_WORKSPACE_ACCESS,
      DEFAULT_CONFIG.allowOutsideWorkspaceAccess,
    ),
    fallbackModelId: config.get<string>(
      CONFIG_KEYS.FALLBACK_MODEL_ID,
      DEFAULT_CONFIG.fallbackModelId,
    ),
    proxyServerCorsOrigins: config.get<string[]>(
      CONFIG_KEYS.PROXY_SERVER_CORS_ORIGINS,
      DEFAULT_CONFIG.proxyServerCorsOrigins,
    ),
  };
};
