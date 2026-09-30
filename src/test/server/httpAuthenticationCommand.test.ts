import * as assert from "assert";
import * as vscode from "vscode";

import { registerLlmApiKeyCommands } from "../../commands/llmApiKeyCommands";
import { HttpAuthentication } from "../../server/httpAuthentication";

suite("HTTP authentication command", () => {
  let handler: () => Promise<void>;
  let action: "set" | "disable" | "import" | undefined;
  let input: string | undefined;
  let legacy: string | undefined;
  let readFailure: boolean;
  let writeFailure: boolean;
  let reads: number;
  let configured: Array<string | null>;
  let successes: string[];
  let errors: string[];
  let restore: () => void;
  let confirmation: string | undefined;
  let warningOptions: vscode.MessageOptions | undefined;

  setup(() => {
    action = undefined;
    confirmation = undefined;
    warningOptions = undefined;
    input = undefined;
    legacy = undefined;
    readFailure = false;
    writeFailure = false;
    reads = 0;
    configured = [];
    successes = [];
    errors = [];
    const originals = {
      register: vscode.commands.registerCommand,
      pick: vscode.window.showQuickPick,
      input: vscode.window.showInputBox,
      info: vscode.window.showInformationMessage,
      error: vscode.window.showErrorMessage,
      warning: vscode.window.showWarningMessage,
    };
    const commands = vscode.commands as any;
    const window = vscode.window as any;
    commands.registerCommand = (_id: string, callback: () => Promise<void>) => {
      handler = callback;
      return { dispose: () => {} };
    };
    window.showQuickPick = async (choices: Array<{ action: string }>) =>
      choices.find((choice) => choice.action === action);
    window.showInputBox = async () => input;
    window.showInformationMessage = async (message: string) => {
      successes.push(message);
    };
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
    };
    window.showWarningMessage = async (
      _message: string,
      options: vscode.MessageOptions,
    ) => {
      warningOptions = options;
      return confirmation;
    };
    restore = () => {
      commands.registerCommand = originals.register;
      window.showQuickPick = originals.pick;
      window.showInputBox = originals.input;
      window.showInformationMessage = originals.info;
      window.showErrorMessage = originals.error;
      window.showWarningMessage = originals.warning;
    };
    const authentication: HttpAuthentication = {
      getStatus: async () => "unavailable",
      authorize: async () => "unavailable",
      configure: async (key) => {
        if (writeFailure) {
          throw new Error("storage write failed");
        }
        configured.push(key);
      },
    };
    registerLlmApiKeyCommands(authentication, {
      subscriptions: [],
      secrets: {
        get: async () => {
          reads++;
          if (readFailure) {
            throw new Error("storage read failed");
          }
          return legacy;
        },
      },
    } as unknown as vscode.ExtensionContext);
  });
  teardown(() => restore());

  test("canceling never disables authentication or reads legacy secrets", async () => {
    await handler();
    action = "set";
    await handler();
    assert.deepStrictEqual(configured, []);
    assert.strictEqual(reads, 0);
    assert.deepStrictEqual(successes, []);
  });
  test("setting a key does not depend on SecretStorage", async () => {
    action = "set";
    input = "new-key";
    readFailure = true;
    await handler();
    assert.deepStrictEqual(configured, ["new-key"]);
    assert.strictEqual(reads, 0);
    assert.strictEqual(successes.length, 1);
  });
  test("disable requires confirming the scope and network exposure", async () => {
    action = "disable";
    confirmation = "Disable authentication";
    readFailure = true;
    await handler();
    assert.deepStrictEqual(configured, [null]);
    assert.strictEqual(reads, 0);
    assert.strictEqual(warningOptions?.modal, true);
    assert.match(warningOptions?.detail ?? "", /all network interfaces/);
    assert.match(warningOptions?.detail ?? "", /all Agent Maestro windows/);
  });
  test("canceling the disable confirmation leaves authentication unchanged", async () => {
    action = "disable";
    await handler();
    assert.deepStrictEqual(configured, []);
    assert.deepStrictEqual(successes, []);
    assert.strictEqual(warningOptions?.modal, true);
  });
  test("legacy import preserves a readable key", async () => {
    action = "import";
    legacy = " legacy-key ";
    await handler();
    assert.deepStrictEqual(configured, ["legacy-key"]);
    assert.strictEqual(reads, 1);
  });
  test("missing or unavailable legacy storage does not disable authentication", async () => {
    action = "import";
    await handler();
    readFailure = true;
    await handler();
    assert.deepStrictEqual(configured, []);
    assert.strictEqual(errors.length, 2);
    assert.deepStrictEqual(successes, []);
  });
  test("failed persistence is never reported as success", async () => {
    action = "set";
    input = "new-key";
    writeFailure = true;
    await handler();
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(successes, []);
  });
});
