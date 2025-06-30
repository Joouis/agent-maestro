import * as vscode from "vscode";

export const closeAllEmptyTabGroups = async (): Promise<void> => {
  const emptyGroups = [];
  for (const group of vscode.window.tabGroups.all) {
    if (group.tabs.length === 0) {
      emptyGroups.push(group);
    }
  }

  try {
    await vscode.window.tabGroups.close(emptyGroups);
  } catch (error) {
    console.error("Error closing empty tab group:", error);
  }
};
