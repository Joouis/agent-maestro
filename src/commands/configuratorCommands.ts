import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { getChatModelsQuickPickItems } from "../utils/chatModels";
import {
  ensureClaudeConfigExists,
  ensureClaudeOnboardingComplete,
} from "../utils/claude";
import { logger } from "../utils/logger";
import { updateEnvFile } from "../utils/updateEnvFile";
import { createCommandHandler } from "./commandHandler";

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
            "No available chat model provided by VS Code LM API.",
          );
          return;
        }

        const selectedMainModel = await vscode.window.showQuickPick(
          modelOptions,
          {
            title: "Select main model (ANTHROPIC_MODEL)",
            placeHolder: "Name of custom model to use",
          },
        );

        if (!selectedMainModel?.modelId) {
          return;
        }

        const selectedFastModel = await vscode.window.showQuickPick(
          modelOptions,
          {
            title: "Select small fast model (ANTHROPIC_SMALL_FAST_MODEL)",
            placeHolder: "Name of Haiku-class model for background tasks",
          },
        );

        if (!selectedFastModel?.modelId) {
          return;
        }

        // Preserve existing auth token if it has a meaningful value
        const currentToken = existingSettings?.env?.ANTHROPIC_AUTH_TOKEN;
        const authToken = currentToken
          ? currentToken
          : "Powered by Agent Maestro";

        const proxyPort = proxy.getStatus().port;

        // Create new settings
        const newSettings = {
          ...existingSettings,
          env: {
            ...existingSettings?.env,
            ANTHROPIC_BASE_URL: `http://localhost:${proxyPort}/api/anthropic`,
            ANTHROPIC_AUTH_TOKEN: authToken,
            ANTHROPIC_MODEL: selectedMainModel.modelId,
            ANTHROPIC_SMALL_FAST_MODEL: selectedFastModel.modelId,
            // Equivalent of setting `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_ERROR_REPORTING`, and `DISABLE_TELEMETRY` to true
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
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
      "agent-maestro.configureCodex",
      createCommandHandler(async () => {
        const codexConfigPath = path.join(
          os.homedir(),
          ".codex",
          "config.toml",
        );

        // Check if config file exists and confirm override
        let fileExists = false;
        try {
          fs.accessSync(codexConfigPath);
          fileExists = true;

          const shouldOverride = await vscode.window.showQuickPick(
            ["Yes", "No"],
            {
              title: "Codex Configuration Found",
              placeHolder:
                "Config file already exists. Do you want to update it?",
            },
          );

          if (shouldOverride !== "Yes") {
            return;
          }
        } catch (error) {
          // File doesn't exist, continue with creation
        }

        const modelOptions = await getChatModelsQuickPickItems({
          recommendedModelId: "gpt-5.1-codex",
          priorityFamily: "openai",
        });

        if (modelOptions.length === 0) {
          vscode.window.showErrorMessage(
            "No available chat model provided by VS Code LM API.",
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

        // Create config content
        const configContent = `# Set the default model and provider
model = "${selectedModel.modelId}"
model_provider = "agent-maestro"

# Configure the Agent Maestro provider
[model_providers.agent-maestro]
name = "Agent Maestro"
base_url = "http://localhost:${proxyPort}/api/openai"
wire_api = "chat"
`;

        // Ensure .codex directory exists
        const codexDir = path.dirname(codexConfigPath);

        try {
          fs.mkdirSync(codexDir, { recursive: true });
        } catch (error) {
          // Directory might already exist, ignore error
        }

        // Write config file
        fs.writeFileSync(codexConfigPath, configContent);

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
          recommendedModelId: "gemini-2.5-pro",
          priorityFamily: "gemini",
        });

        if (modelOptions.length === 0) {
          vscode.window.showErrorMessage(
            "No available chat model provided by VS Code LM API.",
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
            GOOGLE_GEMINI_BASE_URL: `http://localhost:${proxyPort}/api/gemini`,
            GEMINI_API_KEY: "Powered by Agent Maestro",
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
