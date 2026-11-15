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
      assert.strictEqual(DEFAULT_CONFIG.proxyServerPort, 23333);
      assert.strictEqual(DEFAULT_CONFIG.allowOutsideWorkspaceAccess, false);
      assert.strictEqual(DEFAULT_CONFIG.fallbackModelId, "");
    });
  });

  suite("CONFIG_KEYS", () => {
    test("should have correct configuration key prefixes", () => {
      assert.strictEqual(
        CONFIG_KEYS.PROXY_SERVER_PORT,
        "agent-maestro.proxyServerPort",
      );
      assert.strictEqual(
        CONFIG_KEYS.ALLOW_OUTSIDE_WORKSPACE_ACCESS,
        "agent-maestro.allowOutsideWorkspaceAccess",
      );
      assert.strictEqual(
        CONFIG_KEYS.FALLBACK_MODEL_ID,
        "agent-maestro.fallbackModelId",
      );
    });
  });

  suite("readConfiguration", () => {
    test("should return configuration object with all required fields", () => {
      const config = readConfiguration();

      // Check that all fields exist
      assert.ok(
        typeof config.proxyServerPort === "number",
        "proxyServerPort should be a number",
      );
      assert.ok(
        typeof config.allowOutsideWorkspaceAccess === "boolean",
        "allowOutsideWorkspaceAccess should be a boolean",
      );
      assert.ok(
        typeof config.fallbackModelId === "string",
        "fallbackModelId should be a string",
      );
    });

    test("should return a valid port number", () => {
      const config = readConfiguration();

      assert.ok(
        config.proxyServerPort > 0 && config.proxyServerPort < 65536,
        "proxyServerPort should be a valid port number",
      );
    });
  });
});
