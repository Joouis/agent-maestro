import * as vscode from "vscode";

import { logger } from "./logger";

const SECTION = "github.copilot.chat";
const KEY = "responsesApi.promptCacheBreakpoint.enabled";
export const PROMPT_CACHE_BREAKPOINT_SETTING = `${SECTION}.${KEY}`;
const NOTICE_SHOWN_STATE_KEY = "copilotPromptCacheModeNoticeShown";

function readPromptCacheSetting() {
  const configuration = vscode.workspace.getConfiguration(SECTION);
  const inspected = configuration.inspect<boolean>(KEY);
  if (!inspected || typeof inspected.defaultValue !== "boolean") {
    return undefined;
  }

  const configuredValue = inspected.workspaceValue ?? inspected.globalValue;
  const target =
    inspected.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  const targetName =
    target === vscode.ConfigurationTarget.Workspace ? "Workspace" : "User";

  return {
    configuration,
    configuredValue,
    visibleValue: configuration.get<boolean>(KEY),
    target,
    targetName,
  };
}

export async function setCopilotPromptCacheMode(
  explicit: boolean,
): Promise<void> {
  const setting = readPromptCacheSetting();
  if (!setting) {
    throw new Error(
      "Copilot's prompt-cache setting is not available in this VS Code window.",
    );
  }
  if (setting.configuredValue !== explicit) {
    await setting.configuration.update(KEY, explicit, setting.target);
  }
  if (readPromptCacheSetting()?.configuredValue !== explicit) {
    throw new Error(
      "Copilot's prompt-cache setting is still overridden. Check User and Workspace settings.",
    );
  }
  logger.info(
    `Set ${PROMPT_CACHE_BREAKPOINT_SETTING} to ${explicit} in ${setting.targetName} settings`,
  );
  void vscode.window.showInformationMessage(
    `Copilot prompt cache set to ${explicit} (${explicit ? "explicit" : "implicit"}) in ${setting.targetName} settings. This also affects native Copilot Chat.`,
  );
}

export async function configureCopilotPromptCache(): Promise<void> {
  const setting = readPromptCacheSetting();
  if (!setting) {
    throw new Error(
      "Copilot's prompt-cache setting is not available in this VS Code window.",
    );
  }
  const choices: Array<vscode.QuickPickItem & { explicit: boolean }> = [
    {
      label: "false",
      description: "Implicit: automatic prefix caching (recommended for AM)",
      detail:
        "Lets supported GPT models cache matching prefixes without explicit breakpoints.",
      explicit: false,
    },
    {
      label: "true",
      description: "Explicit: cache only prefixes marked with breakpoints",
      detail:
        "Copilot Chat supplies breakpoints; AM's GPT requests do not, so cache hits can stay at zero.",
      explicit: true,
    },
  ];
  const current =
    setting.configuredValue === undefined
      ? `not explicitly configured (visible default: ${setting.visibleValue ?? "unknown"}; Copilot experiments may differ)`
      : String(setting.configuredValue);
  const selected = await vscode.window.showQuickPick(choices, {
    title: `Copilot Prompt Cache — ${setting.targetName} Settings`,
    placeHolder: `Current: ${current}. Also affects native Copilot Chat.`,
    matchOnDescription: true,
  });
  if (selected) {
    await setCopilotPromptCacheMode(selected.explicit);
  }
}

export const checkCopilotPromptCacheSetting = async (
  context: vscode.ExtensionContext,
): Promise<void> => {
  try {
    const setting = readPromptCacheSetting();
    if (
      !setting ||
      setting.configuredValue === false ||
      context.globalState.get<boolean>(NOTICE_SHOWN_STATE_KEY)
    ) {
      return;
    }

    // Copilot reads internal experiment treatments as well as VS Code settings.
    // An unset visible false cannot establish the actual upstream cache mode.
    const risk =
      setting.visibleValue === true
        ? "Copilot's visible setting enables explicit prompt caching, which can prevent cache hits for AM's GPT requests."
        : "Copilot experiments may enable explicit prompt caching and prevent cache hits for AM's GPT requests. AM cannot verify the experiment's mode.";
    const enable = "Use Implicit Cache Mode";
    await context.globalState.update(NOTICE_SHOWN_STATE_KEY, true);
    const choice = await vscode.window.showInformationMessage(
      `${risk} Use implicit mode (false) in ${setting.targetName} settings? This also affects native Copilot Chat. Change it later with 'Configure Copilot Prompt Cache'.`,
      enable,
    );
    if (choice === enable) {
      // Recheck after the notification: a user may have changed the setting meanwhile.
      if (readPromptCacheSetting()?.configuredValue === false) {
        return;
      }
      await setCopilotPromptCacheMode(false);
    }
  } catch (error) {
    logger.error(`Failed to update ${PROMPT_CACHE_BREAKPOINT_SETTING}:`, error);
    const openSettings = "Open Settings";
    const action = await vscode.window.showErrorMessage(
      `Could not configure Copilot prompt caching. Check "${PROMPT_CACHE_BREAKPOINT_SETTING}" in settings.`,
      openSettings,
    );
    if (action === openSettings) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        PROMPT_CACHE_BREAKPOINT_SETTING,
      );
    }
  }
};
