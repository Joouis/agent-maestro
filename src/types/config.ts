/**
 * Configuration interfaces for Agent Maestro extension
 */

/**
 * Configuration for Roo variant identifiers
 */
export interface RooVariantConfiguration {
  /**
   * List of extension identifiers that are considered Roo variants
   * @default ["kilocode.kilo-code"]
   */
  rooVariantIdentifiers: string[];

  /**
   * Default Roo extension identifier to use when multiple variants are available
   * @default "rooveterinaryinc.roo-cline"
   */
  defaultRooExtensionIdentifier: string;
}

/**
 * Complete Agent Maestro configuration
 */
export interface AgentMaestroConfiguration extends RooVariantConfiguration {
  // Future configuration options can be added here
}

/**
 * Configuration keys used in VS Code workspace configuration
 */
export const CONFIG_KEYS = {
  ROO_VARIANT_IDENTIFIERS: "agent-maestro.rooVariantIdentifiers",
  DEFAULT_ROO_EXTENSION_IDENTIFIER:
    "agent-maestro.defaultRooExtensionIdentifier",
} as const;

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: RooVariantConfiguration = {
  rooVariantIdentifiers: ["kilocode.kilo-code"],
  defaultRooExtensionIdentifier: "rooveterinaryinc.roo-cline",
};
