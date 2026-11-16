import * as vscode from "vscode";

import { constantTimeEqual } from "../utils/crypto";

/**
 * Identical keys collapse the LLM/Admin split, so warn but let the user
 * proceed. Returns false when the user cancels.
 */
export async function confirmDistinctFromOtherKey(
  key: string,
  otherKey: string | null,
): Promise<boolean> {
  if (!otherKey || !constantTimeEqual(key, otherKey)) {
    return true;
  }
  const proceed = "Yes";
  const choice = await vscode.window.showWarningMessage(
    "The LLM API Key and the Admin API Key would be identical. Anyone with the LLM key would get full control of the workspace, including reading and writing files. Continue?",
    { modal: true },
    proceed,
  );
  return choice === proceed;
}
