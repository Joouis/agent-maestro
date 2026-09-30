import * as vscode from "vscode";

import { logger } from "./logger";

const SECTION = "github.copilot.chat";
const KEY = "responsesApi.promptCacheBreakpoint.enabled";
export const PROMPT_CACHE_BREAKPOINT_SETTING = `${SECTION}.${KEY}`;
const DISMISSED_STATE_KEY = "copilotPromptCacheBreakpointNoticeDismissed";
const COPILOT_CHAT_EXTENSION_ID = "GitHub.copilot-chat";

/**
 * Copilot Chat 0.67 (bundled with VS Code 1.139) enables explicit prompt-cache
 * mode for GPT-5.6+/GPT-6 Responses requests by default. Explicit mode only
 * caches prefixes marked with cache breakpoints, which Language Model API
 * requests never carry, so GPT requests proxied by Agent Maestro get no cache
 * hits. Copilot 0.68 defaults it off. Experiment-assigned values are not
 * observable, so the installed version is the only runtime signal.
 */
export const isAffectedCopilotVersion = (version: unknown): boolean =>
  typeof version === "string" && /^0\.67\./.test(version);
export const isPromptCacheBreakpointConfigured = (): boolean => {
  const inspected = vscode.workspace
    .getConfiguration(SECTION)
    .inspect<boolean>(KEY);
  return [
    inspected?.globalValue,
    inspected?.workspaceValue,
    inspected?.workspaceFolderValue,
  ].some((value) => value !== undefined);
};

/** Returns true when the setting was written. Never overrides a user value. */
export const disablePromptCacheBreakpoint = async (): Promise<boolean> => {
  if (isPromptCacheBreakpointConfigured()) {
    return false;
  }
  await vscode.workspace
    .getConfiguration(SECTION)
    .update(KEY, false, vscode.ConfigurationTarget.Global);
  logger.info(`Set ${PROMPT_CACHE_BREAKPOINT_SETTING} to false`);
  return true;
};

export const checkCopilotPromptCacheSetting = async (
  context: vscode.ExtensionContext,
): Promise<void> => {
  if (
    !isAffectedCopilotVersion(
      vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID)?.packageJSON
        ?.version,
    ) ||
    isPromptCacheBreakpointConfigured() ||
    context.globalState.get<boolean>(DISMISSED_STATE_KEY)
  ) {
    return;
  }

  const enable = "Disable Explicit Cache Mode";
  const dismiss = "Don't Ask Again";
  const choice = await vscode.window.showInformationMessage(
    `GPT requests proxied by Agent Maestro may get no prompt-cache hits while Copilot's explicit cache mode is enabled, increasing token usage. Set "${PROMPT_CACHE_BREAKPOINT_SETTING}" to false?`,
    enable,
    dismiss,
  );

  if (choice === dismiss) {
    await context.globalState.update(DISMISSED_STATE_KEY, true);
    return;
  }
  if (choice !== enable) {
    return;
  }

  try {
    if (await disablePromptCacheBreakpoint()) {
      vscode.window.showInformationMessage(
        "Copilot explicit prompt-cache mode disabled. GPT prompt caching applies to new requests.",
      );
    }
  } catch (error) {
    logger.error(`Failed to update ${PROMPT_CACHE_BREAKPOINT_SETTING}:`, error);
    const openSettings = "Open Settings";
    const action = await vscode.window.showErrorMessage(
      `Failed to update "${PROMPT_CACHE_BREAKPOINT_SETTING}". Set it to false manually.`,
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
