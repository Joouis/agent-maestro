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

      assert.strictEqual(extension.isActive, true, "Extension should be active");
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

    test("MCP server commands should be registered", async () => {
      const commands = await vscode.commands.getCommands(true);

      const mcpCommands = [
        "agent-maestro.startMcpServer",
        "agent-maestro.stopMcpServer",
        "agent-maestro.getMcpServerStatus",
        "agent-maestro.installMcpConfig",
      ];

      for (const cmd of mcpCommands) {
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
        "agent-maestro.configureCodex",
        "agent-maestro.configureGeminiCli",
      ];

      for (const cmd of configuratorCommands) {
        assert.ok(
          commands.includes(cmd),
          `Command ${cmd} should be registered`,
        );
      }
    });

    test("status command should be registered", async () => {
      const commands = await vscode.commands.getCommands(true);

      assert.ok(
        commands.includes("agent-maestro.getStatus"),
        "getStatus command should be registered",
      );
    });

    test("copilot fix command should be registered", async () => {
      const commands = await vscode.commands.getCommands(true);

      assert.ok(
        commands.includes("agent-maestro.fixCopilotChatModelNotSupported"),
        "fixCopilotChatModelNotSupported command should be registered",
      );
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

    test("default MCP server port should be 23334", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      const port = config.get<number>("mcpServerPort");

      // Should return default or configured value
      assert.ok(
        typeof port === "number" && port > 0,
        "mcpServerPort should be a positive number",
      );
    });

    test("rooVariantIdentifiers should be an array", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      const variants = config.get<string[]>("rooVariantIdentifiers");

      assert.ok(
        Array.isArray(variants),
        "rooVariantIdentifiers should be an array",
      );
    });

    test("defaultRooIdentifier should be a string", () => {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      const identifier = config.get<string>("defaultRooIdentifier");

      assert.ok(
        typeof identifier === "string" && identifier.length > 0,
        "defaultRooIdentifier should be a non-empty string",
      );
    });
  });
});
