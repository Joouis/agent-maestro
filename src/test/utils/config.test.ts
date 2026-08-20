import * as assert from "assert";
import * as vscode from "vscode";

import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
  readConfiguration,
} from "../../utils/config";

suite("Config Test Suite", () => {
  suite("DEFAULT_CONFIG", () => {
    test("should have correct default values", () => {
      assert.deepStrictEqual(DEFAULT_CONFIG.rooVariantIdentifiers, [
        "kilocode.kilo-code",
      ]);
      assert.strictEqual(
        DEFAULT_CONFIG.defaultRooIdentifier,
        "rooveterinaryinc.roo-cline",
      );
      assert.strictEqual(DEFAULT_CONFIG.proxyServerPort, 23333);
      assert.strictEqual(DEFAULT_CONFIG.mcpServerPort, 23334);
      assert.strictEqual(DEFAULT_CONFIG.allowOutsideWorkspaceAccess, false);
    });
  });

  suite("CONFIG_KEYS", () => {
    test("should have correct configuration key prefixes", () => {
      assert.strictEqual(
        CONFIG_KEYS.ROO_VARIANT_IDENTIFIERS,
        "agent-maestro.rooVariantIdentifiers",
      );
      assert.strictEqual(
        CONFIG_KEYS.DEFAULT_ROO_IDENTIFIER,
        "agent-maestro.defaultRooIdentifier",
      );
      assert.strictEqual(
        CONFIG_KEYS.PROXY_SERVER_PORT,
        "agent-maestro.proxyServerPort",
      );
      assert.strictEqual(
        CONFIG_KEYS.MCP_SERVER_PORT,
        "agent-maestro.mcpServerPort",
      );
      assert.strictEqual(
        CONFIG_KEYS.ALLOW_OUTSIDE_WORKSPACE_ACCESS,
        "agent-maestro.allowOutsideWorkspaceAccess",
      );
    });
  });

  suite("readConfiguration", () => {
    test("should return configuration object with all required fields", () => {
      const config = readConfiguration();

      // Check that all fields exist
      assert.ok(
        Array.isArray(config.rooVariantIdentifiers),
        "rooVariantIdentifiers should be an array",
      );
      assert.ok(
        typeof config.defaultRooIdentifier === "string",
        "defaultRooIdentifier should be a string",
      );
      assert.ok(
        typeof config.proxyServerPort === "number",
        "proxyServerPort should be a number",
      );
      assert.ok(
        typeof config.mcpServerPort === "number",
        "mcpServerPort should be a number",
      );
      assert.ok(
        typeof config.allowOutsideWorkspaceAccess === "boolean",
        "allowOutsideWorkspaceAccess should be a boolean",
      );
    });

    test("should return valid port numbers", () => {
      const config = readConfiguration();

      // Ports should be reasonable values
      assert.ok(
        config.proxyServerPort > 0 && config.proxyServerPort < 65536,
        "proxyServerPort should be a valid port number",
      );
      assert.ok(
        config.mcpServerPort > 0 && config.mcpServerPort < 65536,
        "mcpServerPort should be a valid port number",
      );
    });

    test("should return non-empty default extension identifier", () => {
      const config = readConfiguration();

      assert.ok(
        config.defaultRooIdentifier.length > 0,
        "defaultRooIdentifier should not be empty",
      );
      assert.ok(
        config.defaultRooIdentifier.includes("."),
        "defaultRooIdentifier should be in publisher.extension format",
      );
    });
  });
});
