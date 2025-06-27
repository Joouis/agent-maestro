import * as vscode from "vscode";

export interface AgentMaestroConfiguration {
  rooVariantIdentifiers: string[];
  defaultRooIdentifier: string;
}

/**
 * Configuration keys used in VS Code workspace configuration
 */
export const CONFIG_KEYS = {
  ROO_VARIANT_IDENTIFIERS: "agent-maestro.rooVariantIdentifiers",
  DEFAULT_ROO_IDENTIFIER: "agent-maestro.defaultRooIdentifier",
} as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: AgentMaestroConfiguration = {
  rooVariantIdentifiers: ["kilocode.kilo-code"],
  defaultRooIdentifier: "rooveterinaryinc.roo-cline",
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
  };
};
