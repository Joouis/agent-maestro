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

  return {
    configuration,
    userValue: inspected.globalValue,
    workspaceValue: inspected.workspaceValue,
    visibleValue: configuration.get<boolean>(KEY),
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
  if (setting.userValue !== explicit) {
    await setting.configuration.update(
      KEY,
      explicit,
      vscode.ConfigurationTarget.Global,
    );
  }
  const current = readPromptCacheSetting();
  if (current?.userValue !== explicit) {
    throw new Error(
      "Copilot's User prompt-cache setting could not be applied. Check User settings and try again.",
    );
  }
  if (current.workspaceValue !== undefined) {
    try {
      await current.configuration.update(
        KEY,
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
    } catch (error) {
      throw new Error(
        `Copilot's User prompt-cache setting is ${explicit}, but this Workspace's override could not be removed. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  const applied = readPromptCacheSetting();
  if (
    applied?.userValue !== explicit ||
    applied.workspaceValue !== undefined ||
    applied.visibleValue !== explicit
  ) {
    throw new Error(
      "Copilot's prompt-cache setting is still overridden. Check User and Workspace settings.",
    );
  }
  logger.info(
    `Set ${PROMPT_CACHE_BREAKPOINT_SETTING} to ${explicit} in User settings; current Workspace override cleared`,
  );
  void vscode.window.showInformationMessage(
    `Copilot prompt cache set to ${explicit} (${explicit ? "explicit" : "implicit"}) in User settings; this Workspace has no override. This also affects native Copilot Chat in other windows using these User settings. Other Workspace overrides remain unchanged.`,
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
    setting.userValue === undefined
      ? "unset (Copilot experiments may differ)"
      : String(setting.userValue);
  const selected = await vscode.window.showQuickPick(choices, {
    title: "Copilot Prompt Cache — User Settings",
    placeHolder: `User: ${current}; Workspace override: ${setting.workspaceValue ?? "none"}; visible: ${setting.visibleValue ?? "unknown"}. Updates User settings and removes this Workspace's override; also affects native Copilot Chat. Other Workspace overrides remain.`,
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
    if (!setting) {
      return;
    }
    const configuredValue = setting.workspaceValue ?? setting.userValue;
    if (
      configuredValue === false ||
      context.globalState.get<boolean>(NOTICE_SHOWN_STATE_KEY)
    ) {
      return;
    }

    // Copilot reads internal experiment treatments as well as VS Code settings.
    // An unset visible false cannot establish the actual upstream cache mode.
    const risk =
      configuredValue === true
        ? "Copilot is explicitly configured to use explicit prompt caching, which can prevent cache hits for AM's GPT requests."
        : "Copilot's cache mode is not explicitly configured. Experiments may enable explicit prompt caching and prevent cache hits for AM's GPT requests. AM cannot verify the experiment's mode.";
    const enable: vscode.MessageItem = { title: "Use Implicit Cache Mode" };
    const choice = await vscode.window.showWarningMessage(
      risk,
      {
        modal: true,
        detail:
          "Use implicit mode (false) in User settings and remove this Workspace's override? This also affects native Copilot Chat in other windows using these User settings; other Workspace overrides remain. AM will not ask again after you close this dialog. Change the mode later with 'Configure Copilot Prompt Cache'.",
      },
      enable,
      { title: "Keep Current Settings", isCloseAffordance: true },
    );
    await context.globalState.update(NOTICE_SHOWN_STATE_KEY, true);
    if (choice === enable) {
      // Recheck after the notification: a user may have changed the setting meanwhile.
      const current = readPromptCacheSetting();
      if (
        current?.userValue === false &&
        current.workspaceValue === undefined
      ) {
        return;
      }
      await setCopilotPromptCacheMode(false);
    }
  } catch (error) {
    logger.error(`Failed to update ${PROMPT_CACHE_BREAKPOINT_SETTING}:`, error);
    const openSettings = "Open Settings";
    const action = await vscode.window.showErrorMessage(
      `Could not configure Copilot prompt caching: ${error instanceof Error ? error.message : String(error)} Check "${PROMPT_CACHE_BREAKPOINT_SETTING}" in settings.`,
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
