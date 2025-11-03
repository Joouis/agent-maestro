import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  backupExtensionFile,
  findAndRemoveHeader,
  findCopilotChatExtension,
  restoreFromBackup,
  verifyCopilotFix,
} from "../utils/copilotFixer";

suite("Copilot Fixer Test Suite", () => {
  const testDir = path.join(os.tmpdir(), "copilot-fixer-tests");
  const testExtensionJs = path.join(testDir, "extension.js");

  // Sample minified code with the header
  const sampleCodeWithHeader = `S==="getExtraHeaders"?function(){return{...f.getExtraHeaders?.()??{},"x-onbehalf-extension-id":\`\${A}/\${c}\`}}:S==="acquireTokenizer"?f.acquireTokenizer.bind(f):Reflect.get(f,S,D)`;

  const sampleCodeWithoutHeader = `S==="getExtraHeaders"?function(){return{...f.getExtraHeaders?.()??{}}}:S==="acquireTokenizer"?f.acquireTokenizer.bind(f):Reflect.get(f,S,D)`;

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

  suite("findCopilotChatExtension", () => {
    test("should return found=false when extension is not installed", () => {
      const result = findCopilotChatExtension();
      // Note: This test depends on the actual system state
      // In a real test environment, we'd mock the file system
      assert.strictEqual(typeof result.found, "boolean");
    });
  });

  suite("backupExtensionFile", () => {
    test("should create a backup file with timestamp", () => {
      // Create a test file
      fs.writeFileSync(testExtensionJs, sampleCodeWithHeader);

      const result = backupExtensionFile(testExtensionJs);

      assert.strictEqual(result.success, true);
      assert.ok(result.backupPath);
      assert.ok(fs.existsSync(result.backupPath!));

      // Verify backup content matches original
      const backupContent = fs.readFileSync(result.backupPath!, "utf8");
      assert.strictEqual(backupContent, sampleCodeWithHeader);

      // Clean up backup
      if (result.backupPath) {
        fs.unlinkSync(result.backupPath);
      }
    });

    test("should handle backup failure when file doesn't exist", () => {
      const nonExistentFile = path.join(testDir, "nonexistent.js");
      const result = backupExtensionFile(nonExistentFile);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  suite("findAndRemoveHeader", () => {
    test("should successfully remove the header from extension.js", () => {
      // Create test file with header
      fs.writeFileSync(testExtensionJs, sampleCodeWithHeader);

      const result = findAndRemoveHeader(testExtensionJs);

      assert.strictEqual(result.success, true);
      assert.strictEqual(
        result.message,
        "Successfully removed x-onbehalf-extension-id header",
      );

      // Verify the file was modified correctly
      const modifiedContent = fs.readFileSync(testExtensionJs, "utf8");
      assert.strictEqual(modifiedContent, sampleCodeWithoutHeader);
      assert.ok(!modifiedContent.includes("x-onbehalf-extension-id"));
    });

    test("should handle case when header is already removed", () => {
      // Create test file without header
      fs.writeFileSync(testExtensionJs, sampleCodeWithoutHeader);

      const result = findAndRemoveHeader(testExtensionJs);

      assert.strictEqual(result.success, false);
      assert.ok(
        result.message.includes("already been removed") ||
          result.message.includes("not found"),
      );
    });

    test("should handle invalid file path", () => {
      const nonExistentFile = path.join(testDir, "nonexistent.js");
      const result = findAndRemoveHeader(nonExistentFile);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Error processing file"));
    });
  });

  suite("verifyCopilotFix", () => {
    test("should verify header was successfully removed", () => {
      // Create test file without header
      fs.writeFileSync(testExtensionJs, sampleCodeWithoutHeader);

      const result = verifyCopilotFix(testExtensionJs);

      assert.strictEqual(result.verified, true);
      assert.strictEqual(result.message, "Fix verified successfully");
    });

    test("should detect if header is still present", () => {
      // Create test file with header
      fs.writeFileSync(testExtensionJs, sampleCodeWithHeader);

      const result = verifyCopilotFix(testExtensionJs);

      assert.strictEqual(result.verified, false);
      assert.ok(result.message.includes("still present"));
    });

    test("should detect corrupted file", () => {
      // Create test file with invalid content
      fs.writeFileSync(testExtensionJs, "invalid content");

      const result = verifyCopilotFix(testExtensionJs);

      assert.strictEqual(result.verified, false);
      assert.ok(
        result.message.includes("not found") ||
          result.message.includes("corrupted"),
      );
    });
  });

  suite("restoreFromBackup", () => {
    test("should restore file from backup", () => {
      // Create original file with header
      fs.writeFileSync(testExtensionJs, sampleCodeWithHeader);

      // Create backup
      const backupPath = `${testExtensionJs}.backup`;
      fs.copyFileSync(testExtensionJs, backupPath);

      // Modify original
      fs.writeFileSync(testExtensionJs, sampleCodeWithoutHeader);

      // Restore from backup
      const result = restoreFromBackup(testExtensionJs, backupPath);

      assert.strictEqual(result.success, true);

      // Verify restoration
      const restoredContent = fs.readFileSync(testExtensionJs, "utf8");
      assert.strictEqual(restoredContent, sampleCodeWithHeader);

      // Clean up
      fs.unlinkSync(backupPath);
    });

    test("should handle restore failure when backup doesn't exist", () => {
      const nonExistentBackup = path.join(testDir, "nonexistent.backup");
      const result = restoreFromBackup(testExtensionJs, nonExistentBackup);

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
    });
  });

  suite("Integration Test", () => {
    test("should complete full fix workflow successfully", () => {
      // Create test file with header
      fs.writeFileSync(testExtensionJs, sampleCodeWithHeader);

      // 1. Create backup
      const backupResult = backupExtensionFile(testExtensionJs);
      assert.strictEqual(backupResult.success, true);

      // 2. Apply fix
      const fixResult = findAndRemoveHeader(testExtensionJs);
      assert.strictEqual(fixResult.success, true);

      // 3. Verify fix
      const verifyResult = verifyCopilotFix(testExtensionJs);
      assert.strictEqual(verifyResult.verified, true);

      // 4. Verify content
      const content = fs.readFileSync(testExtensionJs, "utf8");
      assert.ok(!content.includes("x-onbehalf-extension-id"));
      assert.ok(content.includes("getExtraHeaders"));

      // Clean up backup
      if (backupResult.backupPath) {
        fs.unlinkSync(backupResult.backupPath);
      }
    });
  });
});
