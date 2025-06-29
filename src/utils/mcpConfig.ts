import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { readConfiguration } from "./config";
import { logger } from "./logger";

/**
 * Result of MCP configuration operation
 */
export interface McpConfigResult {
  success: boolean;
  message: string;
  extensionId?: string;
  configPath?: string;
}

/**
 * Extension information with ID and display name
 */
export interface ExtensionInfo {
  id: string;
  displayName: string;
}

/**
 * Agent Maestro MCP server configuration
 */
export interface AgentMaestroMcpConfig {
  type: "streamable-http";
  url: string;
  alwaysAllow: string[];
  timeout: number;
  disabled: boolean;
}

/**
 * MCP settings file structure
 */
export interface McpSettings {
  [serverName: string]: AgentMaestroMcpConfig | any;
}

/**
 * Options for adding MCP configuration
 */
export interface AddMcpConfigOptions {
  extensionId: string;
  globalStorageUri: vscode.Uri;
}

/**
 * Default Agent Maestro MCP configuration
 */
const DEFAULT_AGENT_MAESTRO_CONFIG: AgentMaestroMcpConfig = {
  type: "streamable-http",
  // TODO: read the port from extension context or configuration
  url: "http://localhost:23334/mcp",
  alwaysAllow: ["Execute Roo Tasks"],
  timeout: 900,
  disabled: false,
};

/**
 * Possible MCP settings file names
 */
const MCP_SETTINGS_FILENAMES = ["cline_mcp_settings.json", "mcp_settings.json"];

/**
 * Gets all available extensions that support MCP configuration and are actually installed
 */
export function getAvailableExtensions(): ExtensionInfo[] {
  const config = readConfiguration();
  const configuredExtensions = [
    config.defaultRooIdentifier,
    ...config.rooVariantIdentifiers,
  ];

  // Filter configured extensions against actually installed extensions
  const installedExtensions = configuredExtensions
    .map((id) => {
      const extension = vscode.extensions.getExtension(id);
      return extension
        ? {
            id,
            displayName:
              extension.packageJSON?.displayName ||
              extension.packageJSON?.name ||
              id,
          }
        : null;
    })
    .filter((ext): ext is ExtensionInfo => ext !== null);

  return installedExtensions;
}

/**
 * Constructs the path to the MCP settings file for a given extension
 */
function getMcpSettingsPath(
  globalStorageUri: vscode.Uri,
  extensionId: string,
  filename: string,
): string {
  return path.join(globalStorageUri.fsPath, extensionId, "settings", filename);
}

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the existing MCP settings file for an extension
 */
async function findExistingMcpSettingsFile(
  globalStorageUri: vscode.Uri,
  extensionId: string,
): Promise<string | null> {
  // Get the parent globalStorage directory to access other extensions' storage
  const globalStorageFolderUri = vscode.Uri.file(
    path.dirname(globalStorageUri.fsPath),
  );

  for (const filename of MCP_SETTINGS_FILENAMES) {
    const filePath = getMcpSettingsPath(
      globalStorageFolderUri,
      extensionId,
      filename,
    );
    if (await fileExists(filePath)) {
      return filePath;
    }
  }
  return null;
}

/**
 * Reads MCP settings from a file
 */
async function readMcpSettings(filePath: string): Promise<McpSettings> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    logger.warn(`Failed to read MCP settings from ${filePath}:`, error);
    return {};
  }
}

/**
 * Writes MCP settings to a file
 */
async function writeMcpSettings(
  filePath: string,
  settings: McpSettings,
): Promise<void> {
  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Write settings with proper formatting
    const content = JSON.stringify(settings, null, 2);
    await fs.promises.writeFile(filePath, content, "utf-8");
  } catch (error) {
    throw new Error(`Failed to write MCP settings to ${filePath}: ${error}`);
  }
}

/**
 * Checks if Agent Maestro configuration already exists in the settings
 */
function hasAgentMaestroConfig(settings: McpSettings): boolean {
  return "Agent Maestro" in settings;
}

/**
 * Adds Agent Maestro MCP server configuration to a supported extension
 *
 * @param options Configuration options including extension ID and storage path
 * @returns Result of the configuration operation
 */
export async function addAgentMaestroMcpConfig(
  options: AddMcpConfigOptions,
): Promise<McpConfigResult> {
  const { extensionId, globalStorageUri } = options;

  try {
    // Find existing MCP settings file or determine where to create one
    let settingsFilePath = await findExistingMcpSettingsFile(
      globalStorageUri,
      extensionId,
    );

    // Return error if settings file path cannot be found
    if (!settingsFilePath) {
      return {
        success: false,
        message: "Could not find MCP settings file for the specified extension",
        extensionId,
      };
    }

    // Read existing settings or start with empty object
    const settings = await readMcpSettings(settingsFilePath);
    if (!settings.mcpServers) {
      settings.mcpServers = {};
    }

    // Check if Agent Maestro config already exists
    if (hasAgentMaestroConfig(settings.mcpServers)) {
      return {
        success: false,
        message: "Agent Maestro MCP configuration already exists",
        extensionId,
        configPath: settingsFilePath,
      };
    }

    // Add the Agent Maestro configuration
    settings.mcpServers["Agent Maestro"] = DEFAULT_AGENT_MAESTRO_CONFIG;

    // Write updated settings back to file
    await writeMcpSettings(settingsFilePath, settings);

    logger.info(
      `Successfully added Agent Maestro MCP configuration for extension "${extensionId}" at ${settingsFilePath}`,
    );

    return {
      success: true,
      message: "Agent Maestro MCP configuration added successfully",
      extensionId,
      configPath: settingsFilePath,
    };
  } catch (error) {
    const errorMessage = `Failed to add Agent Maestro MCP configuration: ${(error as Error).message}`;
    logger.error(errorMessage, error);

    return {
      success: false,
      message: errorMessage,
      extensionId,
    };
  }
}
