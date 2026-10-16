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
  const originalWarning = vscode.window.showWarningMessage;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalError = vscode.window.showErrorMessage;
  const originalExecute = vscode.commands.executeCommand;
  let inspected: Inspected | undefined;
  let updates: Array<{
    key: string;
    value: boolean | undefined;
    target: vscode.ConfigurationTarget;
  }>;
  let messages: Array<{
    message: string;
    actions: string[];
    options?: vscode.MessageOptions;
  }>;
  let errors: string[];
  let choices: readonly CacheItem[];
  let pickerOptions: vscode.QuickPickOptions | undefined;
  let pick: boolean | undefined;
  let acceptNotice: boolean;
  let keepSettings: boolean;
  let notificationError: Error | undefined;
  let state: Map<string, unknown>;
  let context: vscode.ExtensionContext;
  let writeError: Error | undefined;
  let writeErrorTarget: vscode.ConfigurationTarget | undefined;
  let ignoreWrite: boolean;
  let ignoredWriteTarget: vscode.ConfigurationTarget | undefined;
  let onNotification: (() => void) | undefined;
  let onPicker: (() => void) | undefined;
  let onUpdate: (() => void) | undefined;
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
    keepSettings = false;
    notificationError = undefined;
    state = new Map();
    writeError = undefined;
    writeErrorTarget = undefined;
    ignoreWrite = false;
    ignoredWriteTarget = undefined;
    onNotification = undefined;
    onPicker = undefined;
    onUpdate = undefined;
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
          value: boolean | undefined,
          target: vscode.ConfigurationTarget,
        ) => {
          if (
            writeError &&
            (writeErrorTarget === undefined || writeErrorTarget === target)
          ) {
            throw writeError;
          }
          updates.push({ key, value, target });
          if (inspected && !ignoreWrite && target !== ignoredWriteTarget) {
            if (target === vscode.ConfigurationTarget.Workspace) {
              inspected.workspaceValue = value;
            } else {
              inspected.globalValue = value;
            }
          }
          onUpdate?.();
        },
      };
    }) as unknown as typeof vscode.workspace.getConfiguration;
    vscode.window.showInformationMessage = (async (
      message: string,
      ...actions: string[]
    ) => {
      messages.push({ message, actions });
      return undefined;
    }) as unknown as typeof vscode.window.showInformationMessage;
    vscode.window.showWarningMessage = (async (
      message: string,
      options: vscode.MessageOptions,
      ...actions: vscode.MessageItem[]
    ) => {
      messages.push({
        message,
        actions: actions.map(({ title }) => title),
        options,
      });
      if (notificationError) {
        throw notificationError;
      }
      onNotification?.();
      return acceptNotice
        ? actions[0]
        : keepSettings
          ? actions.find((action) => action.isCloseAffordance)
          : undefined;
    }) as unknown as typeof vscode.window.showWarningMessage;
    vscode.window.showQuickPick = (async (
      items: readonly CacheItem[],
      options?: vscode.QuickPickOptions,
    ) => {
      choices = items;
      pickerOptions = options;
      onPicker?.();
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
    vscode.window.showWarningMessage = originalWarning;
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
      "shows a one-time modal warning for an unset default of " + defaultValue,
      async () => {
        inspected = { defaultValue };
        await checkCopilotPromptCacheSetting(context);
        await checkCopilotPromptCacheSetting(context);
        assert.strictEqual(messages.length, 1);
        assert.deepStrictEqual(messages[0].actions, [
          "Use Implicit Mode",
          "Keep Current Settings",
        ]);
        assert.strictEqual(
          messages[0].message,
          "Use implicit mode for prompt caching?",
        );
        assert.match(
          messages[0].options!.detail!,
          /Copilot may be using explicit mode/,
        );
        assert.match(
          messages[0].options!.detail!,
          /prompt cache breakpoints, which Agent Maestro cannot currently support/,
        );
        assert.strictEqual(
          messages[0].options!.detail!.split("\n\n").length,
          2,
        );
        assert.match(
          messages[0].options!.detail!,
          /Implicit mode caches matching input automatically/,
        );
        assert.strictEqual(messages[0].options!.modal, true);
        assert.match(
          messages[0].options!.detail!,
          /Copilot Chat and other windows/,
        );
        assert.match(
          messages[0].options!.detail!,
          /Updates User settings and removes this workspace's override/,
        );
        assert.match(
          messages[0].options!.detail!,
          /other workspace overrides stay unchanged/,
        );
        assert.deepStrictEqual(updates, []);
        assert.deepStrictEqual(
          [...state],
          [["copilotPromptCacheModeNoticeShown", true]],
        );
      },
    );
  }

  for (const value of [
    { defaultValue: true, globalValue: false },
    { globalValue: false },
    { globalValue: false, workspaceValue: false },
    { globalValue: true, workspaceValue: false },
    { workspaceValue: false },
  ]) {
    test(
      "does not notify when implicit mode is explicitly effective: " +
        JSON.stringify(value),
      async () => {
        inspected = value;
        await checkCopilotPromptCacheSetting(context);
        await checkCopilotPromptCacheSetting(context);
        assert.deepStrictEqual(
          { messages, updates },
          { messages: [], updates: [] },
        );
      },
    );
  }

  for (const value of [
    { globalValue: true },
    { globalValue: false, workspaceValue: true },
    { globalValue: true, workspaceValue: true },
  ]) {
    test(
      "warns once when explicit mode is configured: " + JSON.stringify(value),
      async () => {
        inspected = value;
        await checkCopilotPromptCacheSetting(context);
        await checkCopilotPromptCacheSetting(context);
        assert.strictEqual(messages.length, 1);
        assert.match(
          messages[0].options!.detail!,
          /Copilot is set to explicit mode/,
        );
        assert.deepStrictEqual(updates, []);
        assert.deepStrictEqual(
          [...state],
          [["copilotPromptCacheModeNoticeShown", true]],
        );
        assert.strictEqual(messages[0].options!.modal, true);
      },
    );
  }

  test("an acknowledged explicit-mode warning also suppresses later unknown-mode warnings", async () => {
    inspected = { globalValue: true };
    await checkCopilotPromptCacheSetting(context);
    inspected = { defaultValue: false };
    await checkCopilotPromptCacheSetting(context);
    await checkCopilotPromptCacheSetting(context);
    inspected = { globalValue: true };
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.match(
      messages[0].options!.detail!,
      /Copilot is set to explicit mode/,
    );
    assert.deepStrictEqual(updates, []);
  });

  test("an acknowledged unknown-mode warning also suppresses later explicit-mode warnings", async () => {
    await checkCopilotPromptCacheSetting(context);
    inspected = { globalValue: true };
    await checkCopilotPromptCacheSetting(context);
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.match(messages[0].options!.detail!, /Copilot may be using/);
    assert.deepStrictEqual(updates, []);
  });

  test("offers a correction for an explicit true without silently overriding it", async () => {
    inspected = { globalValue: false, workspaceValue: true };
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.match(
      messages[0].options!.detail!,
      /Updates User settings and removes this workspace's override/,
    );
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
    const messageCount = messages.length;
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, messageCount);
    assert.strictEqual(state.size, 1);
  });

  test("removes the Workspace override without rewriting an existing User false", async () => {
    inspected = { globalValue: false, workspaceValue: true };
    acceptNotice = true;
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(updates, [
      {
        key: "responsesApi.promptCacheBreakpoint.enabled",
        value: undefined,
        target: vscode.ConfigurationTarget.Workspace,
      },
    ]);
    assert.strictEqual(inspected.globalValue, false);
    assert.strictEqual(inspected.workspaceValue, undefined);
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

  test("unknown-mode warnings stay one-time after a failed configuration action", async () => {
    acceptNotice = true;
    writeError = new Error("User settings are read-only");
    await checkCopilotPromptCacheSetting(context);
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(state.size, 1);
    assert.deepStrictEqual(updates, []);
  });

  test("records the warning only after the modal has returned", async () => {
    onNotification = () => {
      assert.strictEqual(state.size, 0);
      assert.deepStrictEqual(updates, []);
    };
    await checkCopilotPromptCacheSetting(context);
    assert.deepStrictEqual(
      [...state],
      [["copilotPromptCacheModeNoticeShown", true]],
    );
  });

  test("keeping current settings acknowledges the modal without changing configuration", async () => {
    inspected = { globalValue: true, workspaceValue: true };
    keepSettings = true;
    await checkCopilotPromptCacheSetting(context);
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(state.size, 1);
    assert.deepStrictEqual(updates, []);
    assert.strictEqual(inspected.globalValue, true);
    assert.strictEqual(inspected.workspaceValue, true);
  });

  test("does not suppress a future warning if showing the modal fails", async () => {
    notificationError = new Error("Dialog could not be shown");
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(state.size, 0);
    assert.strictEqual(errors.length, 1);
    notificationError = undefined;
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(state.size, 1);
    assert.deepStrictEqual(updates, []);
  });

  test("explicit-mode warnings stay one-time after a failed configuration action", async () => {
    inspected = { globalValue: true };
    acceptNotice = true;
    writeError = new Error("User settings are read-only");
    await checkCopilotPromptCacheSetting(context);
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(state.size, 1);
    assert.deepStrictEqual(updates, []);
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
          /User: unset.*experiments may differ.*native Copilot Chat/,
        );
        assert.match(
          pickerOptions!.placeHolder!,
          /Updates User settings and removes this Workspace's override/,
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
    inspected = { globalValue: true, workspaceValue: false };
    await configureCopilotPromptCache();
    assert.match(
      pickerOptions!.placeHolder!,
      /User: true; Workspace override: false/,
    );
    assert.deepStrictEqual(
      { updates, messages },
      { updates: [], messages: [] },
    );
  });

  test("command toggles User settings and clears only the current Workspace override", async () => {
    inspected = { globalValue: false, workspaceValue: true };
    pick = false;
    await configureCopilotPromptCache();
    pick = true;
    await configureCopilotPromptCache();
    assert.deepStrictEqual(
      updates.map(({ value, target }) => ({ value, target })),
      [
        { value: undefined, target: vscode.ConfigurationTarget.Workspace },
        { value: true, target: vscode.ConfigurationTarget.Global },
      ],
    );
    assert.strictEqual(inspected.globalValue, true);
    assert.strictEqual(inspected.workspaceValue, undefined);
    assert.match(pickerOptions!.title!, /User Settings/);
  });

  for (const explicit of [false, true]) {
    test(
      "writes User before removing an opposite Workspace override for " +
        explicit,
      async () => {
        inspected = { globalValue: !explicit, workspaceValue: !explicit };
        await setCopilotPromptCacheMode(explicit);
        assert.deepStrictEqual(
          updates.map(({ value, target }) => ({ value, target })),
          [
            { value: explicit, target: vscode.ConfigurationTarget.Global },
            { value: undefined, target: vscode.ConfigurationTarget.Workspace },
          ],
        );
        assert.strictEqual(inspected.globalValue, explicit);
        assert.strictEqual(inspected.workspaceValue, undefined);
      },
    );

    test("clears a matching Workspace override for " + explicit, async () => {
      inspected = { globalValue: explicit, workspaceValue: explicit };
      await setCopilotPromptCacheMode(explicit);
      assert.deepStrictEqual(
        updates.map(({ value, target }) => ({ value, target })),
        [{ value: undefined, target: vscode.ConfigurationTarget.Workspace }],
      );
    });
  }

  for (const entrypoint of ["notification", "picker"] as const) {
    for (const workspaceAppears of [false, true]) {
      test(`${entrypoint} keeps User-level consent when a Workspace override ${workspaceAppears ? "appears" : "disappears"} while open`, async () => {
        inspected = {
          globalValue: true,
          workspaceValue: workspaceAppears ? undefined : true,
        };
        const changeOverride = () => {
          inspected!.workspaceValue = workspaceAppears ? true : undefined;
        };
        if (entrypoint === "notification") {
          acceptNotice = true;
          onNotification = changeOverride;
          await checkCopilotPromptCacheSetting(context);
        } else {
          pick = false;
          onPicker = changeOverride;
          await configureCopilotPromptCache();
        }
        assert.deepStrictEqual(
          updates.map(({ value, target }) => ({ value, target })),
          [
            { value: false, target: vscode.ConfigurationTarget.Global },
            ...(workspaceAppears
              ? [
                  {
                    value: undefined,
                    target: vscode.ConfigurationTarget.Workspace,
                  },
                ]
              : []),
          ],
        );
        assert.strictEqual(inspected.globalValue, false);
        assert.strictEqual(inspected.workspaceValue, undefined);
      });
    }
  }

  test("removes an override added while the User write is pending", async () => {
    onUpdate = () => {
      inspected!.workspaceValue = true;
      onUpdate = undefined;
    };
    await setCopilotPromptCacheMode(false);
    assert.deepStrictEqual(
      updates.map(({ value, target }) => ({ value, target })),
      [
        { value: false, target: vscode.ConfigurationTarget.Global },
        { value: undefined, target: vscode.ConfigurationTarget.Workspace },
      ],
    );
  });

  test("preserves the Workspace override when the User write fails", async () => {
    inspected = { globalValue: true, workspaceValue: true };
    writeError = new Error("User settings are read-only");
    await assert.rejects(
      setCopilotPromptCacheMode(false),
      /User settings are read-only/,
    );
    assert.deepStrictEqual(updates, []);
    assert.strictEqual(inspected.workspaceValue, true);
    assert.deepStrictEqual(messages, []);
  });

  test("reports the partial result when Workspace cleanup fails", async () => {
    inspected = { globalValue: true, workspaceValue: true };
    writeError = new Error("Workspace settings are read-only");
    writeErrorTarget = vscode.ConfigurationTarget.Workspace;
    await assert.rejects(
      setCopilotPromptCacheMode(false),
      /User prompt-cache setting is false.*Workspace's override could not be removed/,
    );
    assert.deepStrictEqual(
      updates.map(({ value, target }) => ({ value, target })),
      [{ value: false, target: vscode.ConfigurationTarget.Global }],
    );
    assert.strictEqual(inspected.globalValue, false);
    assert.strictEqual(inspected.workspaceValue, true);
    assert.deepStrictEqual(messages, []);
  });

  test("notification explains a saved User setting when Workspace cleanup fails", async () => {
    inspected = { globalValue: true, workspaceValue: true };
    writeError = new Error("Workspace settings are read-only");
    writeErrorTarget = vscode.ConfigurationTarget.Workspace;
    acceptNotice = true;
    await checkCopilotPromptCacheSetting(context);
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.match(
      errors[0],
      /User prompt-cache setting is false.*Workspace's override could not be removed/,
    );
    assert.strictEqual(inspected.globalValue, false);
    assert.strictEqual(inspected.workspaceValue, true);
  });

  test("rejects ineffective Workspace cleanup even when its value matches User settings", async () => {
    inspected = { globalValue: false, workspaceValue: false };
    ignoredWriteTarget = vscode.ConfigurationTarget.Workspace;
    await assert.rejects(setCopilotPromptCacheMode(false), /still overridden/);
    assert.deepStrictEqual(messages, []);
  });

  test("does not rewrite an already explicit matching choice", async () => {
    inspected = { globalValue: false };
    await setCopilotPromptCacheMode(false);
    assert.deepStrictEqual(updates, []);
  });

  test("rejects an ineffective update rather than reporting success", async () => {
    inspected = { globalValue: true, workspaceValue: true };
    ignoreWrite = true;
    await assert.rejects(
      setCopilotPromptCacheMode(false),
      /User prompt-cache setting could not be applied/,
    );
    assert.strictEqual(inspected.workspaceValue, true);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].target, vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(messages, []);
  });
});
