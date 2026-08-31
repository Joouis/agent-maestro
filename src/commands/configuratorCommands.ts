import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse, stringify } from "smol-toml";
import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { getChatModelsQuickPickItems } from "../utils/chatModels";
import { withClaudeCode1mSuffix } from "../utils/claude";
import {
  ensureClaudeConfigExists,
  ensureClaudeOnboardingComplete,
} from "../utils/claude";
import {
  createClaudeDesktopGatewayConfig,
  getClaudeDesktopConfigDirectory,
  updateClaudeDesktopMetadata,
} from "../utils/claudeDesktop";
import { logger } from "../utils/logger";
import { updateEnvFile } from "../utils/updateEnvFile";
import { createCommandHandler } from "./commandHandler";

const LOOPBACK_HOST = "127.0.0.1";

export function registerConfiguratorCommands(
  proxy: ProxyServer,
  context: vscode.ExtensionContext,
) {
  const disposables = [
    vscode.commands.registerCommand(
      "agent-maestro.configureClaudeCode",
      createCommandHandler(async () => {
        // Ask user whether to configure user settings or project settings
        const settingsType = await vscode.window.showQuickPick(
          [
            {
              label: "User Settings",
              description:
                "Personal global settings for all projects (~/.claude/settings.json)",
            },
            {
              label: "Project Settings",
              description:
                "Team-shared project settings in source control (.claude/settings.json)",
            },
          ],
          {
            title: "Configure Claude Code Settings",
            placeHolder: "Choose where to save Claude Code settings",
          },
        );

        if (!settingsType) {
          return;
        }

        let claudeDir: vscode.Uri;
        let settingsFile: vscode.Uri;

        if (settingsType.label === "User Settings") {
          // Use user's home directory
          const homePath = os.homedir();
          claudeDir = vscode.Uri.file(homePath).with({
            path: homePath + "/.claude",
          });
          settingsFile = vscode.Uri.joinPath(claudeDir, "settings.json");
        } else {
          // Use project directory
          const workspaceRoot =
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!workspaceRoot) {
            vscode.window.showErrorMessage(
              "No workspace folder found. Please open a workspace to configure project Claude Code settings.",
            );
            return;
          }

          claudeDir = vscode.Uri.joinPath(
            vscode.Uri.file(workspaceRoot),
            ".claude",
          );
          settingsFile = vscode.Uri.joinPath(claudeDir, "settings.json");
        }

        // Check if settings file exists and confirm override
        let existingSettings: any = {};
        let fileExists = false;
        try {
          const settingsContent =
            await vscode.workspace.fs.readFile(settingsFile);
          existingSettings = JSON.parse(settingsContent.toString());
          fileExists = true;

          const shouldOverride = await vscode.window.showQuickPick(
            ["Yes", "No"],
            {
              title: "Claude Code Settings Found",
              placeHolder:
                "Settings file already exists. Do you want to update it?",
            },
          );

          if (shouldOverride !== "Yes") {
            return;
          }
        } catch (error) {
          // File doesn't exist, continue with creation
        }

        const modelOptions = await getChatModelsQuickPickItems({
          priorityFamily: "claude",
        });

        if (modelOptions.length === 0) {
          vscode.window.showErrorMessage(
            "No chat models are currently available from the VS Code Language Model API.",
          );
          return;
        }

        const selectedDefaultModel = await vscode.window.showQuickPick(
          modelOptions,
          {
            title: "Select default model (ANTHROPIC_MODEL)",
            placeHolder: "Name of default model to use",
          },
        );

        if (!selectedDefaultModel?.modelId) {
          return;
        }

        // Preserve existing auth token if it has a meaningful value
        const currentToken = existingSettings?.env?.ANTHROPIC_AUTH_TOKEN;
        const authToken = currentToken
          ? currentToken
          : "Powered by Agent Maestro";

        const proxyPort = proxy.getStatus().port;
        const existingEnv = { ...existingSettings?.env };
        // Remove the deprecated Claude Code small-fast override when rewriting settings.
        delete existingEnv.ANTHROPIC_SMALL_FAST_MODEL;
        const autoCompactWindow = selectedDefaultModel.maxInputTokens
          ? String(selectedDefaultModel.maxInputTokens)
          : undefined;

        // Create new settings
        const newSettings = {
          ...existingSettings,
          env: {
            ...existingEnv,
            ANTHROPIC_BASE_URL: `http://${LOOPBACK_HOST}:${proxyPort}/api/anthropic`,
            ANTHROPIC_AUTH_TOKEN: authToken,
            ANTHROPIC_MODEL: withClaudeCode1mSuffix(
              selectedDefaultModel.modelId,
              selectedDefaultModel.maxInputTokens,
            ),
            ...(autoCompactWindow
              ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: autoCompactWindow }
              : {}),
            CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:
              existingEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? "85",
            // Equivalent of setting `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_ERROR_REPORTING`, and `DISABLE_TELEMETRY` to true
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            // Disable the x-anthropic-billing-header (CCH) which can break prompt caching on non-Anthropic LLM gateways
            CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
          },
        };

        // Ensure .claude directory exists
        try {
          await vscode.workspace.fs.createDirectory(claudeDir);
        } catch (error) {
          // Directory might already exist, ignore error
        }

        // Write settings file
        await vscode.workspace.fs.writeFile(
          settingsFile,
          Buffer.from(JSON.stringify(newSettings, null, 2)),
        );

        // Ensure Claude config exists with primaryApiKey for seamless compatibility
        ensureClaudeConfigExists();

        // Ensure Claude onboarding is marked as complete
        ensureClaudeOnboardingComplete();

        vscode.window.showInformationMessage(
          `Claude Code settings ${fileExists ? "updated" : "created"} successfully! The settings point to Agent Maestro proxy server for Anthropic-compatible API.`,
        );

        logger.info(
          `Claude Code settings ${fileExists ? "updated" : "created"}: ${settingsFile.fsPath}`,
        );
      }, "Failed to configure Claude Code settings"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.configureClaudeDesktop",
      createCommandHandler(async () => {
        const configDirectory = getClaudeDesktopConfigDirectory();
        const metadataPath = path.join(configDirectory, "_meta.json");
        let metadata: {
          appliedId?: string;
          entries?: Array<{ id: string; name: string }>;
        } = {};

        try {
          metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            vscode.window.showErrorMessage(
              `Failed to read Claude Desktop metadata: ${(error as Error).message}`,
            );
            return;
          }
        }

        const updatedMetadata = updateClaudeDesktopMetadata(metadata);
        const settingsPath = path.join(
          configDirectory,
          `${updatedMetadata.appliedId}.json`,
        );
        let existingSettings: Record<string, unknown> = {};
        let fileExists = false;

        try {
          existingSettings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
          fileExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            vscode.window.showErrorMessage(
              `Failed to read Claude Desktop settings: ${(error as Error).message}`,
            );
            return;
          }
        }

        if (fileExists) {
          const shouldOverride = await vscode.window.showQuickPick(
            ["Yes", "No"],
            {
              title: "Claude Desktop Settings Found",
              placeHolder:
                "Settings already exist for Agent Maestro. Do you want to update them?",
            },
          );

          if (shouldOverride !== "Yes") {
            return;
          }
        }

        const proxyPort = proxy.getStatus().port;
        const updatedSettings = {
          ...existingSettings,
          ...createClaudeDesktopGatewayConfig(proxyPort),
        };

        fs.mkdirSync(configDirectory, { recursive: true });
        fs.writeFileSync(
          settingsPath,
          JSON.stringify(updatedSettings, null, 2),
        );
        fs.writeFileSync(
          metadataPath,
          JSON.stringify(updatedMetadata, null, 2),
        );

        vscode.window.showInformationMessage(
          `Claude Desktop settings ${fileExists ? "updated" : "created"} successfully! Fully quit and reopen Claude Desktop to apply the Agent Maestro proxy configuration.`,
        );
        logger.info(
          `Claude Desktop settings ${fileExists ? "updated" : "created"}: ${settingsPath}`,
        );
      }, "Failed to configure Claude Desktop settings"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.configureCodex",
      createCommandHandler(async () => {
        const codexConfigPath = path.join(
          os.homedir(),
          ".codex",
          "config.toml",
        );

        // Try to read existing config
        let existingConfig: any = {};
        let fileExists = false;
        let parseError = false;

        try {
          fs.accessSync(codexConfigPath);
          fileExists = true;

          try {
            existingConfig = parse(fs.readFileSync(codexConfigPath, "utf-8"));
          } catch (error) {
            parseError = true;
            logger.warn(
              `Failed to parse existing Codex config: ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          // Prompt user to confirm update
          const prompt = parseError
            ? "Failed to load existing config file. Do you want to create a fresh configuration?"
            : "Config file already exists. Do you want to update it?";

          const shouldOverride = await vscode.window.showQuickPick(
            ["Yes", "No"],
            {
              title: "Codex Configuration Found",
              placeHolder: prompt,
            },
          );

          if (shouldOverride !== "Yes") {
            return;
          }

          // Reset to empty config if parse failed
          if (parseError) {
            existingConfig = {};
          }
        } catch (error) {
          // File doesn't exist, continue with creation
        }

        const modelOptions = await getChatModelsQuickPickItems({
          recommendedModelId: "gpt-5.5",
          priorityFamily: "openai",
        });

        if (modelOptions.length === 0) {
          vscode.window.showErrorMessage(
            "No chat models are currently available from the VS Code Language Model API.",
          );
          return;
        }

        const selectedModel = await vscode.window.showQuickPick(modelOptions, {
          title: "Select model",
          placeHolder: "Choose which model to use with Codex",
        });

        if (!selectedModel?.modelId) {
          return;
        }

        const proxyPort = proxy.getStatus().port;

        const modelContextWindow = selectedModel.maxInputTokens ?? undefined;

        // Build updated config by merging with existing config
        const updatedConfig = {
          ...existingConfig,
          model: selectedModel.modelId,
          model_provider: "agent-maestro",
          ...(modelContextWindow !== undefined && {
            model_context_window: modelContextWindow,
          }),
          model_providers: {
            ...existingConfig.model_providers,
            "agent-maestro": {
              name: "Agent Maestro",
              base_url: `http://${LOOPBACK_HOST}:${proxyPort}/api/openai/v1`,
              wire_api: "responses",
              supports_standalone_web_search: true,
            },
          },
        };

        // Ensure .codex directory exists
        const codexDir = path.dirname(codexConfigPath);

        try {
          fs.mkdirSync(codexDir, { recursive: true });
        } catch (error) {
          // Directory might already exist, ignore error
        }

        // Write config file using smol-toml stringify
        fs.writeFileSync(codexConfigPath, stringify(updatedConfig));

        vscode.window.showInformationMessage(
          `Codex configuration ${fileExists ? "updated" : "created"} successfully! The configuration points to Agent Maestro proxy server for OpenAI-compatible API.`,
        );

        logger.info(
          `Codex configuration ${fileExists ? "updated" : "created"}: ${codexConfigPath}`,
        );

        // Ask user if they want to reload window to make Codex configuration take effect
        const shouldReload = await vscode.window.showQuickPick(["Yes", "No"], {
          title: "Reload Window",
          placeHolder:
            "Reload VS Code window to apply Codex configuration changes?",
        });

        if (shouldReload === "Yes") {
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      }, "Failed to configure Codex settings"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.configureGeminiCli",
      createCommandHandler(async () => {
        const workspaceRootUri = vscode.workspace.workspaceFolders?.[0]?.uri;

        let projectEnvExists = false;
        if (workspaceRootUri) {
          try {
            const envUri = vscode.Uri.joinPath(workspaceRootUri, ".env");
            await vscode.workspace.fs.stat(envUri);
            projectEnvExists = true;
          } catch (error) {
            // .env doesn't exist
          }
        }

        // Ask user whether to configure user settings or project settings
        const settingsType = await vscode.window.showQuickPick(
          [
            {
              label: "Project Settings",
              description:
                "Team-shared project settings in source control (.gemini/.env)",
            },
            {
              label: "User Settings",
              description:
                "Personal global settings for all projects (~/.gemini/.env)",
              detail: projectEnvExists
                ? "$(warning) Note: A .env file exists at workspace root. Gemini CLI will prioritize it over user settings."
                : undefined,
            },
          ],
          {
            title: "Configure Gemini CLI Settings",
            placeHolder: "Choose where to save Gemini CLI settings",
          },
        );

        if (!settingsType) {
          return;
        }

        let envFilePath: string;

        if (settingsType.label === "User Settings") {
          // Use user's home directory
          envFilePath = path.join(os.homedir(), ".gemini", ".env");
        } else {
          // Use project directory
          if (!workspaceRootUri) {
            vscode.window.showErrorMessage(
              "No workspace folder found. Please open a workspace to configure project Gemini CLI settings.",
            );
            return;
          }

          envFilePath = path.join(workspaceRootUri.fsPath, ".gemini", ".env");
        }

        // Check if .env file exists and confirm override
        let fileExists = false;
        try {
          fs.accessSync(envFilePath);
          fileExists = true;

          const shouldOverride = await vscode.window.showQuickPick(
            ["Yes", "No"],
            {
              title: "Gemini CLI Settings Found",
              placeHolder:
                ".env file already exists. Do you want to update it?",
            },
          );

          if (shouldOverride !== "Yes") {
            return;
          }
        } catch (error) {
          // File doesn't exist, continue with creation
        }

        const modelOptions = await getChatModelsQuickPickItems({
          recommendedModelId: "gemini-3.5-flash",
          priorityFamily: "gemini",
        });

        if (modelOptions.length === 0) {
          vscode.window.showErrorMessage(
            "No chat models are currently available from the VS Code Language Model API.",
          );
          return;
        }

        const selectedModel = await vscode.window.showQuickPick(modelOptions, {
          title: "Select model",
          placeHolder: "Choose which model to use with Gemini CLI",
        });

        if (!selectedModel?.modelId) {
          return;
        }

        const proxyPort = proxy.getStatus().port;

        // Update .env file with the three required variables
        await updateEnvFile(
          envFilePath,
          {
            GOOGLE_GEMINI_BASE_URL: `http://${LOOPBACK_HOST}:${proxyPort}/api/gemini`,
            GEMINI_API_KEY: '"Powered by Agent Maestro"',
            GEMINI_MODEL: selectedModel.modelId,
            GEMINI_TELEMETRY_ENABLED: "false",
          },
          ["GEMINI_API_KEY"], // Preserve existing GEMINI_API_KEY if it exists
        );

        // Create or update settings.json to skip auth selection on first launch
        const geminiDir = path.dirname(envFilePath);
        const settingsJsonPath = path.join(geminiDir, "settings.json");

        let settingsContent = {
          security: {
            auth: {
              selectedType: "gemini-api-key",
            },
          },
        };

        try {
          const existingSettingsContent = fs.readFileSync(
            settingsJsonPath,
            "utf8",
          );
          const existingSettings = JSON.parse(existingSettingsContent);

          // Preserve existing settings and update selectedType
          settingsContent = {
            ...existingSettings,
            security: {
              ...existingSettings?.security,
              auth: {
                ...existingSettings?.security?.auth,
                selectedType: "gemini-api-key",
              },
            },
          };
        } catch (error) {
          // File doesn't exist, use default settings
        }

        fs.writeFileSync(
          settingsJsonPath,
          JSON.stringify(settingsContent, null, 2),
        );

        vscode.window.showInformationMessage(
          `Gemini CLI settings ${fileExists ? "updated" : "created"} successfully! The settings point to Agent Maestro proxy server for Gemini-compatible API.`,
        );

        logger.info(
          `Gemini CLI settings ${fileExists ? "updated" : "created"}: ${envFilePath}`,
        );
        logger.info(`Gemini CLI settings.json created: ${settingsJsonPath}`);
      }, "Failed to configure Gemini CLI settings"),
    ),
  ];

  context.subscriptions.push(...disposables);
}
