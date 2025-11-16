import * as vscode from "vscode";

import { ExtensionController } from "../core/controller";
import { getSystemInfo } from "../utils/systemInfo";
import { createCommandHandler } from "./commandHandler";

export function registerStatusCommands(
  controller: ExtensionController,
  context: vscode.ExtensionContext,
) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.getStatus",
    createCommandHandler(() => {
      const systemInfo = getSystemInfo(controller);
      vscode.window.showInformationMessage(JSON.stringify(systemInfo, null, 2));
    }, "Failed to get system status"),
  );

  context.subscriptions.push(disposable);
}
