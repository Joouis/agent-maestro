import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Test Suite", () => {
  const EXTENSION_ID = "Joouis.agent-maestro";

  suite("Extension Activation", () => {
    test("extension should be present", () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, `Extension ${EXTENSION_ID} should be installed`);
    });

    test("extension should activate successfully", async function () {
      this.timeout(10000); // Allow 10 seconds for activation

      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, "Extension should be present");

      if (!extension.isActive) {
        await extension.activate();
      }

      assert.strictEqual(
        extension.isActive,
        true,
        "Extension should be active",
      );
    });
  });

  suite("Commands Registration", () => {
    test("proxy server commands should be registered", async () => {
      const commands = await vscode.commands.getCommands(true);

      const proxyCommands = [
        "agent-maestro.startProxyServer",
        "agent-maestro.stopProxyServer",
        "agent-maestro.restartProxyServer",
        "agent-maestro.getProxyServerStatus",
      ];

      for (const cmd of proxyCommands) {
        assert.ok(
          commands.includes(cmd),
          `Command ${cmd} should be registered`,
        );
      }
    });

    test("configurator commands should be registered", async () => {
      const commands = await vscode.commands.getCommands(true);

      const configuratorCommands = [
        "agent-maestro.configureClaudeCode",
        "agent-maestro.configureClaudeDesktop",
        "agent-maestro.configureCodex",
        "agent-maestro.configureGrokBuild",
        "agent-maestro.configureGeminiCli",
        "agent-maestro.selectFallbackModel",
        "agent-maestro.configureCopilotPromptCache",
      ];

      for (const cmd of configuratorCommands) {
        assert.ok(
          commands.includes(cmd),
          `Command ${cmd} should be registered`,
        );
      }
    });

    test("removed orchestration commands are not registered", async () => {
      const commands = await vscode.commands.getCommands(true);

      for (const cmd of [
        "agent-maestro.getStatus",
        "agent-maestro.startMcpServer",
        "agent-maestro.stopMcpServer",
        "agent-maestro.getMcpServerStatus",
        "agent-maestro.installMcpConfig",
      ]) {
        assert.ok(!commands.includes(cmd), `Command ${cmd} should be removed`);
      }
    });
  });

  suite("Configuration", () => {
    test("configuration section should exist", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      assert.ok(config, "agent-maestro configuration section should exist");
    });

    test("default proxy server port should be 23333", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      const port = config.get<number>("proxyServerPort");

      // Should return default or configured value
      assert.ok(
        typeof port === "number" && port > 0,
        "proxyServerPort should be a positive number",
      );
    });

    test("removed orchestration settings are not contributed", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");

      for (const key of [
        "mcpServerPort",
        "mcpServerCorsOrigins",
        "rooVariantIdentifiers",
        "defaultRooIdentifier",
      ]) {
        assert.strictEqual(
          config.inspect(key)?.defaultValue,
          undefined,
          `Setting ${key} should be removed`,
        );
      }
    });

    test("fallbackModelId should be a string", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      const fallbackModelId = config.get<string>("fallbackModelId");

      assert.strictEqual(typeof fallbackModelId, "string");
    });
  });
});
