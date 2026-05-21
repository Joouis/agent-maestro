import * as vscode from "vscode";

import { DashboardPanel } from "../dashboard/DashboardPanel";
import { ProxyServer } from "../server/ProxyServer";
import { metricsCollector } from "../server/metrics/MetricsCollector";
import { createCommandHandler } from "./commandHandler";

export function registerDashboardCommands(
  context: vscode.ExtensionContext,
  proxy: ProxyServer,
) {
  const disposable = vscode.commands.registerCommand(
    "agent-maestro.openDashboard",
    createCommandHandler(() => {
      DashboardPanel.show(context, metricsCollector, proxy.getStatus().url);
    }, "Failed to open dashboard"),
  );

  context.subscriptions.push(disposable);
}
