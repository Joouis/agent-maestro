import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { logger } from "./logger";

/**
 * Interface for Claude config.json structure
 */
interface ClaudeConfig {
  primaryApiKey?: string;
  [key: string]: any;
}

/**
 * Interface for Claude settings.json structure
 */
interface ClaudeSettings {
  env?: {
    ANTHROPIC_AUTH_TOKEN?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

/**
 * Ensures that ~/.claude.json has hasCompletedOnboarding set to true
 * This prevents Claude Code from showing the onboarding flow
 */
export const ensureClaudeOnboardingComplete = (): boolean => {
  try {
    const claudeJsonPath = path.join(os.homedir(), ".claude.json");
    let claudeJsonContent: any = {};
    let needsUpdate = false;

    try {
      const existingContent = fs.readFileSync(claudeJsonPath, "utf8");
      claudeJsonContent = JSON.parse(existingContent);

      // Check if hasCompletedOnboarding is not true
      if (claudeJsonContent.hasCompletedOnboarding !== true) {
        claudeJsonContent.hasCompletedOnboarding = true;
        needsUpdate = true;
      }
    } catch (error) {
      // File doesn't exist or is invalid JSON, create new
      claudeJsonContent = { hasCompletedOnboarding: true };
      needsUpdate = true;
    }

    if (needsUpdate) {
      fs.writeFileSync(
        claudeJsonPath,
        JSON.stringify(claudeJsonContent, null, 2),
      );
      logger.info(`Updated onboarding status in ${claudeJsonPath}`);
    }

    return true;
  } catch (error) {
    logger.error(`Failed to update ~/.claude.json: ${error}`);
    return false;
  }
};

/**
 * Ensures that the Claude config.json file exists with primaryApiKey set to "Agent Maestro"
 * This is a shared utility for ensuring the essential config exists
 */
export const ensureClaudeConfigExists = (): boolean => {
  try {
    const configPath = path.join(os.homedir(), ".claude", "config.json");
    const configDir = path.dirname(configPath);

    // Ensure .claude directory exists
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    let config: ClaudeConfig = {};
    let fileExists = false;

    // Read existing config if it exists
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, "utf8");
        config = JSON.parse(configContent);
        fileExists = true;
      } catch (error) {
        logger.error("Error reading existing Claude config:", error);
        // Continue with empty config if parsing fails
      }
    }

    // Check if primaryApiKey already exists
    if (!config.primaryApiKey) {
      config.primaryApiKey = "Agent Maestro";

      // Write the config file
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      logger.info(
        `Claude config ${fileExists ? "updated" : "created"} with primaryApiKey: ${configPath}`,
      );
    }

    return true;
  } catch (error) {
    logger.error("Error ensuring Claude config exists:", error);
    return false;
  }
};

/**
 * Checks if the user has ever used Agent Maestro to configure Claude Code settings
 * Returns true if either workspace or home directory has .claude/settings.json with Agent Maestro token
 */
const hasAgentMaestroClaudeSettings = (): boolean => {
  const checkSettingsFile = (settingsPath: string): boolean => {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }

    try {
      const settingsContent = fs.readFileSync(settingsPath, "utf8");
      const settings: ClaudeSettings = JSON.parse(settingsContent);

      const authToken = settings.env?.ANTHROPIC_AUTH_TOKEN;
      return !!authToken?.includes("Agent Maestro");
    } catch (error) {
      logger.debug(
        `Error reading Claude settings from ${settingsPath}:`,
        error,
      );
      return false;
    }
  };

  // Check workspace .claude/settings.json
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceRoot) {
    const workspaceSettingsPath = path.join(
      workspaceRoot,
      ".claude",
      "settings.json",
    );
    return checkSettingsFile(workspaceSettingsPath);
  }

  // Check home directory .claude/settings.json
  const homeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  return checkSettingsFile(homeSettingsPath);
};

/**
 * Read Claude settings to get user's configured models
 * This reads from .claude/settings.json in workspace or home directory
 */
export const getClaudeConfiguredModels = (): {
  mainModel: string;
  fastModel: string;
} | null => {
  try {
    // Try workspace settings first, then home directory
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let settingsPath: string;

    if (workspaceRoot) {
      settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
      if (!fs.existsSync(settingsPath)) {
        settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      }
    } else {
      settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    }

    if (!fs.existsSync(settingsPath)) {
      return null;
    }

    const settingsContent = fs.readFileSync(settingsPath, "utf8");
    const settings: ClaudeSettings = JSON.parse(settingsContent);

    const mainModel = settings.env?.ANTHROPIC_MODEL;
    const fastModel = settings.env?.ANTHROPIC_SMALL_FAST_MODEL;

    if (mainModel && fastModel) {
      return { mainModel, fastModel };
    }

    return null;
  } catch (error) {
    logger.debug("Could not read Claude settings:", error);
    return null;
  }
};

/**
 * Performs self-check when extension activates:
 * 1. Check if current workspace or homedir has .claude/settings.json with Agent Maestro token
 * 2. If yes, ensure homedir has .claude/config.json with primaryApiKey set to "Agent Maestro"
 */
export const performClaudeCodeSelfCheck = (): void => {
  try {
    logger.info("Performing Claude Code self-check...");

    // Step 1: Check if user has ever used Agent Maestro for Claude Code settings
    const hasAgentMaestroSettings = hasAgentMaestroClaudeSettings();

    if (!hasAgentMaestroSettings) {
      logger.info(
        "No Agent Maestro Claude Code settings detected, skipping config check",
      );
      return;
    }

    logger.info("Agent Maestro Claude Code settings detected");

    // Step 2: Ensure Claude config exists with primaryApiKey
    if (ensureClaudeConfigExists()) {
      logger.info("Claude Code self-check completed successfully");
    } else {
      logger.error("Failed to ensure Claude config exists");
    }
  } catch (error) {
    logger.error("Error during Claude Code self-check:", error);
  }
};
