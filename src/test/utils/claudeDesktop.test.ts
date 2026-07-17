import * as assert from "assert";
import * as path from "path";

import {
  createClaudeDesktopGatewayConfig,
  getClaudeDesktopConfigDirectory,
  updateClaudeDesktopMetadata,
} from "../../utils/claudeDesktop";

suite("Claude Desktop Configuration Test Suite", () => {
  test("uses the documented local config directories on each platform", () => {
    assert.strictEqual(
      getClaudeDesktopConfigDirectory("darwin", "/Users/example"),
      path.join(
        "/Users/example",
        "Library",
        "Application Support",
        "Claude-3p",
        "configLibrary",
      ),
    );
    assert.strictEqual(
      getClaudeDesktopConfigDirectory(
        "win32",
        "C:\\Users\\example",
        "C:\\Users\\example\\AppData\\Local",
      ),
      path.join(
        "C:\\Users\\example\\AppData\\Local",
        "Claude-3p",
        "configLibrary",
      ),
    );
    assert.strictEqual(
      getClaudeDesktopConfigDirectory("linux", "/home/example"),
      path.join("/home/example", ".config", "Claude-3p", "configLibrary"),
    );
  });

  test("adds and applies an Agent Maestro metadata entry", () => {
    const metadata = updateClaudeDesktopMetadata(
      {
        appliedId: "default-id",
        entries: [{ id: "default-id", name: "Default" }],
      },
      () => "agent-maestro-id",
    );

    assert.deepStrictEqual(metadata, {
      appliedId: "agent-maestro-id",
      entries: [
        { id: "default-id", name: "Default" },
        { id: "agent-maestro-id", name: "agent-maestro" },
      ],
    });
  });

  test("reuses an existing Agent Maestro metadata entry", () => {
    const entries = [
      { id: "default-id", name: "Default" },
      { id: "agent-maestro-id", name: "agent-maestro" },
    ];
    const metadata = updateClaudeDesktopMetadata(
      { appliedId: "default-id", entries },
      () => {
        throw new Error("A new id should not be created");
      },
    );

    assert.strictEqual(metadata.appliedId, "agent-maestro-id");
    assert.strictEqual(metadata.entries, entries);
  });

  test("creates the expected gateway settings", () => {
    assert.deepStrictEqual(createClaudeDesktopGatewayConfig(45678), {
      inferenceGatewayBaseUrl: "http://127.0.0.1:45678/api/anthropic",
      inferenceGatewayApiKey: "Powered by Agent Maestro",
      inferenceProvider: "gateway",
      inferenceCredentialKind: "static",
    });
  });
});
