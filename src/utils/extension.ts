import * as vscode from "vscode";
import { logger } from "./logger";

export const closeAllEmptyTabGroups = async (): Promise<void> => {
  const emptyGroups: vscode.TabGroup[] = [];
  for (const group of vscode.window.tabGroups.all) {
    if (group.tabs.length === 0) {
      emptyGroups.push(group);
    }
  }

  try {
    await vscode.window.tabGroups.close(emptyGroups);
  } catch (error) {
    logger.error("Error closing empty tab groups:", error);
  }
};
