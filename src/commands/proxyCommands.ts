import * as vscode from "vscode";

import { ProxyServer } from "../server/ProxyServer";
import { ANOTHER_INSTANCE_RUNNING_MESSAGE } from "../utils/constant";
import { logger } from "../utils/logger";
import { createCommandHandler } from "./commandHandler";

export function registerProxyCommands(
  proxy: ProxyServer,
  context: vscode.ExtensionContext,
) {
  const disposables = [
    vscode.commands.registerCommand(
      "agent-maestro.startProxyServer",
      createCommandHandler(async () => {
        if (!proxy) {
          vscode.window.showErrorMessage("Proxy server not initialized");
          return;
        }

        const result = await proxy.start();

        if (result.started) {
          vscode.window.showInformationMessage(
            `Agent Maestro proxy server started successfully. View API documentation at ${proxy.getOpenApiUrl()}`,
          );
        } else {
          // Don't show error message for "another instance running" case
          if (result.reason === ANOTHER_INSTANCE_RUNNING_MESSAGE) {
            logger.info(`Proxy server startup skipped: ${result.reason}`);
          } else {
            vscode.window.showInformationMessage(
              `Proxy server startup: ${result.reason}`,
            );
          }
        }
      }, "Failed to start server"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.stopProxyServer",
      createCommandHandler(async () => {
        if (!proxy) {
          vscode.window.showErrorMessage("Proxy server not initialized");
          return;
        }

        await proxy.stop();
        vscode.window.showInformationMessage("Proxy server stopped");
      }, "Failed to stop server"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.restartProxyServer",
      createCommandHandler(async () => {
        if (!proxy) {
          vscode.window.showErrorMessage("Proxy server not initialized");
          return;
        }

        await proxy.stop();
        const result = await proxy.start();

        if (result.started) {
          const status = proxy.getStatus();
          vscode.window.showInformationMessage(
            `Proxy server restarted on ${status.url}`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Server restart: ${result.reason}`,
          );
        }
      }, "Failed to restart server"),
    ),

    vscode.commands.registerCommand(
      "agent-maestro.getProxyServerStatus",
      createCommandHandler(() => {
        if (!proxy) {
          vscode.window.showErrorMessage("Proxy server not initialized");
          return;
        }

        const status = proxy.getStatus();
        vscode.window.showInformationMessage(
          `Server Status: ${status.isRunning ? "Running" : "Stopped"} | Port: ${status.port} | URL: ${status.url}`,
        );
      }, "Failed to get proxy server status"),
    ),
  ];

  context.subscriptions.push(...disposables);
}
