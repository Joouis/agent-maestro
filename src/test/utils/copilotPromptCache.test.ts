import * as assert from "assert";
import * as vscode from "vscode";

import {
  PROMPT_CACHE_BREAKPOINT_SETTING,
  disablePromptCacheBreakpoint,
  isAffectedCopilotVersion,
  isPromptCacheBreakpointConfigured,
} from "../../utils/copilotPromptCache";

type Inspected = {
  globalValue?: boolean;
  workspaceValue?: boolean;
  workspaceFolderValue?: boolean;
};

suite("Copilot Prompt Cache Setting Test Suite", () => {
  const workspace = vscode.workspace as {
    getConfiguration: typeof vscode.workspace.getConfiguration;
  };
  const original = workspace.getConfiguration;
  let inspected: Inspected;
  let updates: Array<{
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
  }>;

  setup(() => {
    inspected = {};
    updates = [];
    workspace.getConfiguration = ((section?: string) => {
      assert.strictEqual(section, "github.copilot.chat");
      return {
        inspect: () => inspected,
        update: async (
          key: string,
          value: unknown,
          target: vscode.ConfigurationTarget,
        ) => {
          updates.push({ key, value, target });
        },
      };
    }) as unknown as typeof vscode.workspace.getConfiguration;
  });

  teardown(() => {
    workspace.getConfiguration = original;
  });

  test("uses the Copilot explicit prompt-cache setting", () => {
    assert.strictEqual(
      PROMPT_CACHE_BREAKPOINT_SETTING,
      "github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled",
    );
  });

  test("treats a setting left at its default as unconfigured", () => {
    assert.strictEqual(isPromptCacheBreakpointConfigured(), false);
  });

  test("treats explicit true or false at any scope as configured", () => {
    for (const value of [
      { globalValue: true },
      { globalValue: false },
      { workspaceValue: true },
      { workspaceFolderValue: false },
    ]) {
      inspected = value;
      assert.strictEqual(isPromptCacheBreakpointConfigured(), true);
    }
  });

  test("writes false to user settings when unconfigured", async () => {
    assert.strictEqual(await disablePromptCacheBreakpoint(), true);
    assert.deepStrictEqual(updates, [
      {
        key: "responsesApi.promptCacheBreakpoint.enabled",
        value: false,
        target: vscode.ConfigurationTarget.Global,
      },
    ]);
  });

  test("never overrides an explicit user value", async () => {
    inspected = { globalValue: true };
    assert.strictEqual(await disablePromptCacheBreakpoint(), false);
    assert.deepStrictEqual(updates, []);
  });

  test("only treats Copilot Chat 0.67 as affected", () => {
    assert.strictEqual(isAffectedCopilotVersion("0.67.0"), true);
    assert.strictEqual(isAffectedCopilotVersion("0.67.3"), true);
    for (const version of ["0.66.0", "0.68.0", "0.68.2026092907", "", 67]) {
      assert.strictEqual(isAffectedCopilotVersion(version), false);
    }
    assert.strictEqual(isAffectedCopilotVersion(undefined), false);
  });
});
