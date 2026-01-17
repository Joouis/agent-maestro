import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { updateEnvFile } from "../../utils/updateEnvFile";

suite("UpdateEnvFile Test Suite", () => {
  const testDir = path.join(os.tmpdir(), "updateEnvFile-tests");
  const testEnvFile = path.join(testDir, ".env");

  setup(() => {
    // Create test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  teardown(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  suite("Creating new .env files", () => {
    test("should create a new .env file with provided values", async () => {
      const updates = {
        API_KEY: "my-api-key",
        BASE_URL: "http://localhost:3000",
        DEBUG: "true",
      };

      await updateEnvFile(testEnvFile, updates);

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("API_KEY=my-api-key"));
      assert.ok(content.includes("BASE_URL=http://localhost:3000"));
      assert.ok(content.includes("DEBUG=true"));
    });

    test("should create parent directories if they don't exist", async () => {
      const nestedPath = path.join(testDir, "nested", "deep", ".env");

      await updateEnvFile(nestedPath, { KEY: "value" });

      assert.ok(fs.existsSync(nestedPath));
      const content = fs.readFileSync(nestedPath, "utf8");
      assert.ok(content.includes("KEY=value"));
    });
  });

  suite("Updating existing .env files", () => {
    test("should update existing key values", async () => {
      // Create initial file
      fs.writeFileSync(testEnvFile, "EXISTING_KEY=old-value\nOTHER_KEY=other");

      await updateEnvFile(testEnvFile, { EXISTING_KEY: "new-value" });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("EXISTING_KEY=new-value"));
      assert.ok(content.includes("OTHER_KEY=other"));
      assert.ok(!content.includes("old-value"));
    });

    test("should add new keys while preserving existing ones", async () => {
      // Create initial file
      fs.writeFileSync(testEnvFile, "EXISTING=existing-value");

      await updateEnvFile(testEnvFile, { NEW_KEY: "new-value" });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("EXISTING=existing-value"));
      assert.ok(content.includes("NEW_KEY=new-value"));
    });

    test("should preserve comments and blank lines", async () => {
      // Create initial file with comments
      const initialContent = `# Configuration file
API_KEY=old-key

# Database settings
DB_HOST=localhost`;
      fs.writeFileSync(testEnvFile, initialContent);

      await updateEnvFile(testEnvFile, { API_KEY: "new-key" });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("# Configuration file"));
      assert.ok(content.includes("# Database settings"));
      assert.ok(content.includes("API_KEY=new-key"));
      assert.ok(content.includes("DB_HOST=localhost"));
    });
  });

  suite("Preserving keys", () => {
    test("should not overwrite keys specified in preserveKeys", async () => {
      // Create initial file
      fs.writeFileSync(testEnvFile, "API_KEY=existing-secret");

      await updateEnvFile(
        testEnvFile,
        { API_KEY: "new-value", OTHER: "other-value" },
        ["API_KEY"],
      );

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(
        content.includes("API_KEY=existing-secret"),
        "Preserved key should keep original value",
      );
      assert.ok(content.includes("OTHER=other-value"));
    });

    test("should add preserved keys if they don't exist", async () => {
      // Create empty file
      fs.writeFileSync(testEnvFile, "");

      await updateEnvFile(
        testEnvFile,
        { NEW_KEY: "default-value" },
        ["NEW_KEY"],
      );

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(
        content.includes("NEW_KEY=default-value"),
        "Non-existing preserved key should be added with provided value",
      );
    });

    test("should handle mixed preserve and update keys", async () => {
      fs.writeFileSync(testEnvFile, "PRESERVE=keep\nUPDATE=old");

      await updateEnvFile(
        testEnvFile,
        {
          PRESERVE: "should-not-change",
          UPDATE: "new",
          NEW: "added",
        },
        ["PRESERVE"],
      );

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("PRESERVE=keep"));
      assert.ok(content.includes("UPDATE=new"));
      assert.ok(content.includes("NEW=added"));
    });
  });

  suite("Edge cases", () => {
    test("should handle empty updates object", async () => {
      fs.writeFileSync(testEnvFile, "EXISTING=value");

      await updateEnvFile(testEnvFile, {});

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.strictEqual(content, "EXISTING=value");
    });

    test("should handle values with special characters", async () => {
      await updateEnvFile(testEnvFile, {
        URL: "http://example.com?param=value&other=123",
        QUOTED: '"quoted value"',
        EQUALS: "key=value=more",
      });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("URL=http://example.com?param=value&other=123"));
      assert.ok(content.includes('QUOTED="quoted value"'));
      assert.ok(content.includes("EQUALS=key=value=more"));
    });

    test("should handle empty values", async () => {
      await updateEnvFile(testEnvFile, {
        EMPTY: "",
        NOT_EMPTY: "value",
      });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("EMPTY="));
      assert.ok(content.includes("NOT_EMPTY=value"));
    });

    test("should handle keys with underscores and numbers", async () => {
      await updateEnvFile(testEnvFile, {
        MY_API_KEY_123: "value",
        CONFIG_V2_ENABLED: "true",
      });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("MY_API_KEY_123=value"));
      assert.ok(content.includes("CONFIG_V2_ENABLED=true"));
    });

    test("should handle Windows-style line endings (CRLF)", async () => {
      fs.writeFileSync(testEnvFile, "KEY1=value1\r\nKEY2=value2\r\n");

      await updateEnvFile(testEnvFile, { KEY1: "updated" });

      const content = fs.readFileSync(testEnvFile, "utf8");
      assert.ok(content.includes("KEY1=updated"));
      assert.ok(content.includes("KEY2=value2"));
    });
  });
});
