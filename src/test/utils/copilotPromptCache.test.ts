import * as assert from "assert";
import * as vscode from "vscode";

import {
  PROMPT_CACHE_BREAKPOINT_SETTING,
  checkCopilotPromptCacheSetting,
  configureCopilotPromptCache,
  setCopilotPromptCacheMode,
} from "../../utils/copilotPromptCache";

interface Inspected {
  defaultValue?: boolean;
  globalValue?: boolean;
  workspaceValue?: boolean;
}

type CacheItem = vscode.QuickPickItem & { explicit: boolean };

suite("Copilot Prompt Cache Setting Test Suite", () => {
  const originalConfiguration = vscode.workspace.getConfiguration;
  const originalInformation = vscode.window.showInformationMessage;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalError = vscode.window.showErrorMessage;
  const originalExecute = vscode.commands.executeCommand;
  let inspected: Inspected | undefined;
  let updates: Array<{
    key: string;
    value: boolean;
    target: vscode.ConfigurationTarget;
  }>;
  let messages: Array<{ message: string; actions: string[] }>;
  let errors: string[];
  let choices: readonly CacheItem[];
  let pickerOptions: vscode.QuickPickOptions | undefined;
  let pick: boolean | undefined;
  let acceptNotice: boolean;
  let state: Map<string, unknown>;
  let context: vscode.ExtensionContext;
  let writeError: Error | undefined;
  let ignoreWrite: boolean;
  let onNotification: (() => void) | undefined;
  let openSettings: boolean;
  let commands: Array<[string, ...unknown[]]>;

  setup(() => {
    inspected = { defaultValue: false };
    updates = [];
    messages = [];
    errors = [];
    choices = [];
    pickerOptions = undefined;
    pick = undefined;
    acceptNotice = false;
    state = new Map();
    writeError = undefined;
    ignoreWrite = false;
    onNotification = undefined;
    openSettings = false;
    commands = [];
    context = {
      globalState: {
        get: (key: string) => state.get(key),
        update: async (key: string, value: unknown) => {
          state.set(key, value);
        },
      },
    } as unknown as vscode.ExtensionContext;

    vscode.workspace.getConfiguration = ((section?: string) => {
      assert.strictEqual(section, "github.copilot.chat");
      return {
        inspect: () => inspected && { defaultValue: false, ...inspected },
        get: () =>
          inspected?.workspaceValue ??
          inspected?.globalValue ??
          inspected?.defaultValue,
        update: async (
          key: string,
          value: boolean,
          target: vscode.ConfigurationTarget,
        ) => {
          if (writeError) {
            throw writeError;
          }
          updates.push({ key, value, target });
          if (inspected && !ignoreWrite) {
            if (target === vscode.ConfigurationTarget.Workspace) {
              inspected.workspaceValue = value;
            } else {
              inspected.globalValue = value;
            }
          }
        },
      };
    }) as unknown as typeof vscode.workspace.getConfiguration;
    vscode.window.showInformationMessage = (async (
      message: string,
      ...actions: string[]
    ) => {
      messages.push({ message, actions });
      if (actions.includes("Use Implicit Cache Mode")) {
        onNotification?.();
        return acceptNotice ? "Use Implicit Cache Mode" : undefined;
      }
      return undefined;
    }) as unknown as typeof vscode.window.showInformationMessage;
    vscode.window.showQuickPick = (async (
      items: readonly CacheItem[],
      options?: vscode.QuickPickOptions,
    ) => {
      choices = items;
      pickerOptions = options;
      return items.find((item) => item.explicit === pick);
    }) as unknown as typeof vscode.window.showQuickPick;
    vscode.window.showErrorMessage = (async (message: string) => {
      errors.push(message);
      return openSettings ? "Open Settings" : undefined;
    }) as typeof vscode.window.showErrorMessage;
    vscode.commands.executeCommand = (async (
      command: string,
      ...args: unknown[]
    ) => {
      commands.push([command, ...args]);
    }) as typeof vscode.commands.executeCommand;
  });

  teardown(() => {
    vscode.workspace.getConfiguration = originalConfiguration;
    vscode.window.showInformationMessage = originalInformation;
    vscode.window.showQuickPick = originalQuickPick;
    vscode.window.showErrorMessage = originalError;
    vscode.commands.executeCommand = originalExecute;
  });

  test("uses the Copilot explicit prompt-cache setting", () => {
    assert.strictEqual(
      PROMPT_CACHE_BREAKPOINT_SETTING,
      "github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled",
    );
  });

  for (const defaultValue of [true, false]) {
    test(
      "offers a one-time notice for an unset default of " + defaultValue,
      async () => {
        inspected = { defaultValue };
        await checkCopilotPromptCacheSetting(context);
        await checkCopilotPromptCacheSetting(context);
        assert.strictEqual(messages.length, 1);
        assert.deepStrictEqual(messages[0].actions, [
          "Use Implicit Cache Mode",
        ]);
        assert.match(
          messages[0].message,
          defaultValue
            ? /visible setting enables explicit/
            : /experiments may enable explicit/,
        );
        assert.match(messages[0].message, /native Copilot Chat/);
        assert.deepStrictEqual(updates, []);
      },
    );
  }

  for (const value of [
    { defaultValue: true, globalValue: false },
    { globalValue: true, workspaceValue: false },
    { globalValue: false, workspaceValue: false },
  ]) {
    test(
      "does not notify when implicit is explicitly effective: " +
        JSON.stringify(value),
      async () => {
        inspected = value;
        await checkCopilotPromptCacheSetting(context);
        assert.deepStrictEqual(
          { messages, updates },
          { messages: [], updates: [] },
        );
      },
    );
  }

  test("offers a correction for an explicit true without silently overriding it", async () => {
    inspected = { globalValue: false, workspaceValue: true };
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0].message, /Workspace settings/);
    assert.deepStrictEqual(updates, []);
  });

  test("applies implicit to User settings only after the notification button is clicked", async () => {
    acceptNotice = true;
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(updates, [
      {
        key: "responsesApi.promptCacheBreakpoint.enabled",
        value: false,
        target: vscode.ConfigurationTarget.Global,
      },
    ]);
    assert.match(messages.at(-1)!.message, /false \(implicit\).*User settings/);
  });

  test("changes the active workspace override instead of leaving it above a user false", async () => {
    inspected = { globalValue: false, workspaceValue: true };
    acceptNotice = true;
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(updates, [
      {
        key: "responsesApi.promptCacheBreakpoint.enabled",
        value: false,
        target: vscode.ConfigurationTarget.Workspace,
      },
    ]);
    assert.strictEqual(inspected.globalValue, false);
  });

  test("respects a manual implicit choice made while the notification is open", async () => {
    acceptNotice = true;
    onNotification = () => {
      inspected!.globalValue = false;
    };
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(updates, []);
    assert.strictEqual(messages.length, 1);
  });

  test("does not notify or write when Copilot's setting is unavailable", async () => {
    inspected = undefined;
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(
      { messages, updates },
      { messages: [], updates: [] },
    );
    await assert.rejects(configureCopilotPromptCache(), /not available/);
    assert.deepStrictEqual(choices, []);
  });

  test("does not offer an unregistered setting left behind in workspace JSON", async () => {
    inspected = { defaultValue: undefined, workspaceValue: true };
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(
      { messages, updates },
      { messages: [], updates: [] },
    );
    await assert.rejects(configureCopilotPromptCache(), /not available/);
  });

  test("reports a failed notification action and offers settings without claiming success", async () => {
    acceptNotice = true;
    openSettings = true;
    writeError = new Error("settings are read-only");
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(updates, []);
    assert.deepStrictEqual(commands, [
      ["workbench.action.openSettings", PROMPT_CACHE_BREAKPOINT_SETTING],
    ]);
  });

  for (const explicit of [false, true]) {
    test(
      "command explains both options and applies " +
        explicit +
        " after selection",
      async () => {
        pick = explicit;
        await configureCopilotPromptCache();
        assert.deepStrictEqual(
          choices.map((item) => ({
            label: item.label,
            explicit: item.explicit,
          })),
          [
            { label: "false", explicit: false },
            { label: "true", explicit: true },
          ],
        );
        assert.match(
          choices[0].description!,
          /Implicit.*automatic prefix caching/,
        );
        assert.match(choices[1].description!, /Explicit.*breakpoints/);
        assert.match(choices[1].detail!, /zero/);
        assert.match(pickerOptions!.title!, /User Settings/);
        assert.match(
          pickerOptions!.placeHolder!,
          /not explicitly configured.*experiments may differ.*native Copilot Chat/,
        );
        assert.deepStrictEqual(updates, [
          {
            key: "responsesApi.promptCacheBreakpoint.enabled",
            value: explicit,
            target: vscode.ConfigurationTarget.Global,
          },
        ]);
        assert.match(messages[0].message, /native Copilot Chat/);
      },
    );
  }

  test("command cancellation does not change settings", async () => {
    inspected = { globalValue: true };
    await configureCopilotPromptCache();
    assert.match(pickerOptions!.placeHolder!, /Current: true/);
    assert.deepStrictEqual(
      { updates, messages },
      { updates: [], messages: [] },
    );
  });

  test("command can toggle both directions in the controlling workspace scope", async () => {
    inspected = { globalValue: false, workspaceValue: true };
    pick = false;
    await configureCopilotPromptCache();
    pick = true;
    await configureCopilotPromptCache();
    assert.deepStrictEqual(
      updates.map(({ value, target }) => ({ value, target })),
      [
        { value: false, target: vscode.ConfigurationTarget.Workspace },
        { value: true, target: vscode.ConfigurationTarget.Workspace },
      ],
    );
    assert.strictEqual(inspected.globalValue, false);
    assert.match(pickerOptions!.title!, /Workspace Settings/);
  });

  test("does not rewrite an already explicit matching choice", async () => {
    inspected = { globalValue: false };
    await setCopilotPromptCacheMode(false);
    assert.deepStrictEqual(updates, []);
  });

  test("rejects an ineffective update rather than reporting success", async () => {
    ignoreWrite = true;
    await assert.rejects(setCopilotPromptCacheMode(false), /still overridden/);
    assert.deepStrictEqual(messages, []);
  });
});
