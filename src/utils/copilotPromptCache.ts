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
  context: vscode.ExtensionContext,
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
  if (!explicit) {
    try {
      await context.globalState.update(NOTICE_SHOWN_STATE_KEY, undefined);
    } catch (error) {
      throw new Error(
        `Implicit mode is enabled, but AM could not reset its cache warning reminder. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  logger.info(
    `Set ${PROMPT_CACHE_BREAKPOINT_SETTING} to ${explicit} in User settings; current Workspace override cleared`,
  );
  void vscode.window.showInformationMessage(
    `Copilot prompt caching set to ${explicit ? "explicit" : "implicit"} mode in User settings. Workspace override cleared.`,
  );
}

export async function configureCopilotPromptCache(
  context: vscode.ExtensionContext,
): Promise<void> {
  const setting = readPromptCacheSetting();
  if (!setting) {
    throw new Error(
      "Copilot's prompt-cache setting is not available in this VS Code window.",
    );
  }
  const choices: Array<vscode.QuickPickItem & { explicit: boolean }> = [
    {
      label: "Implicit",
      detail:
        "Recommended for Agent Maestro. Caches matching prompt prefixes automatically.",
      explicit: false,
    },
    {
      label: "Explicit",
      detail:
        "Requires prompt cache breakpoints, which Agent Maestro cannot currently provide.",
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
    matchOnDetail: true,
  });
  if (selected) {
    await setCopilotPromptCacheMode(selected.explicit, context);
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
        ? "Copilot is set to explicit mode."
        : "Copilot may be using explicit mode.";
    const enable: vscode.MessageItem = { title: "Use Implicit Mode" };
    const choice = await vscode.window.showWarningMessage(
      "Use implicit mode for prompt caching?",
      {
        modal: true,
        detail: `${risk} Explicit mode needs prompt cache breakpoints, which Agent Maestro cannot currently support. This can cause cache misses and higher token costs. Implicit mode caches matching input automatically.\n\nUpdates User settings and removes this workspace's override. Also affects Copilot Chat and other windows; other workspace overrides stay unchanged.`,
      },
      enable,
      { title: "Keep Current Settings", isCloseAffordance: true },
    );
    await context.globalState.update(NOTICE_SHOWN_STATE_KEY, true);
    if (choice === enable) {
      await setCopilotPromptCacheMode(false, context);
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
