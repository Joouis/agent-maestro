import * as assert from "assert";

import {
  ErrorResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
  ExtensionInfoSchema,
  OSInfoSchema,
} from "../../server/schemas/common";

suite("Common Schemas Test Suite", () => {
  suite("ErrorResponseSchema", () => {
    test("should validate error responses", () => {
      assert.strictEqual(ErrorResponseSchema.safeParse({ message: "Error" }).success, true);
      assert.strictEqual(ErrorResponseSchema.safeParse({}).success, false);
      assert.strictEqual(ErrorResponseSchema.safeParse({ message: 123 }).success, false);
    });
  });

  suite("FileReadRequestSchema", () => {
    test("should validate file read requests", () => {
      assert.strictEqual(FileReadRequestSchema.safeParse({ path: "src/index.ts" }).success, true);
      assert.strictEqual(FileReadRequestSchema.safeParse({ path: "/absolute/path" }).success, true);
      assert.strictEqual(FileReadRequestSchema.safeParse({ path: "" }).success, false);
      assert.strictEqual(FileReadRequestSchema.safeParse({}).success, false);
    });
  });

  suite("FileReadResponseSchema", () => {
    test("should validate file read responses", () => {
      const validResponse = {
        path: "src/index.ts",
        content: "console.log('Hello');",
        encoding: "utf8",
        size: 28,
        mimeType: "application/typescript",
      };
      assert.strictEqual(FileReadResponseSchema.safeParse(validResponse).success, true);
      assert.strictEqual(FileReadResponseSchema.safeParse({ path: "f", content: "c" }).success, false);
    });
  });

  suite("FileWriteRequestSchema", () => {
    test("should validate file write requests", () => {
      assert.strictEqual(
        FileWriteRequestSchema.safeParse({ path: "out.txt", content: "data", encoding: "utf8" }).success,
        true,
      );
      assert.strictEqual(
        FileWriteRequestSchema.safeParse({ path: "img.png", content: "abc=", encoding: "base64" }).success,
        true,
      );
      assert.strictEqual(
        FileWriteRequestSchema.safeParse({ path: "f", content: "c", encoding: "invalid" }).success,
        false,
      );
      assert.strictEqual(
        FileWriteRequestSchema.safeParse({ path: "", content: "c", encoding: "utf8" }).success,
        false,
      );
    });
  });

  suite("FileWriteResponseSchema", () => {
    test("should validate file write responses", () => {
      assert.strictEqual(FileWriteResponseSchema.safeParse({ path: "out.txt", size: 256 }).success, true);
      assert.strictEqual(FileWriteResponseSchema.safeParse({ path: "out.txt" }).success, false);
      assert.strictEqual(FileWriteResponseSchema.safeParse({ path: "out.txt", size: "256" }).success, false);
    });
  });

  suite("ExtensionInfoSchema", () => {
    test("should validate extension info", () => {
      assert.strictEqual(
        ExtensionInfoSchema.safeParse({ isInstalled: true, isActive: true, version: "1.0.0" }).success,
        true,
      );
      assert.strictEqual(
        ExtensionInfoSchema.safeParse({ isInstalled: false, isActive: false }).success,
        true,
      );
      assert.strictEqual(ExtensionInfoSchema.safeParse({ isActive: true }).success, false);
      assert.strictEqual(ExtensionInfoSchema.safeParse({ isInstalled: true }).success, false);
    });
  });

  suite("OSInfoSchema", () => {
    test("should validate OS info for all platforms", () => {
      const platforms = [
        { platform: "darwin", arch: "arm64", release: "24.5.0", homedir: "/Users/u" },
        { platform: "win32", arch: "x64", release: "10.0.22631", homedir: "C:\\Users\\u" },
        { platform: "linux", arch: "x64", release: "5.15.0", homedir: "/home/u" },
      ];
      for (const info of platforms) {
        assert.strictEqual(OSInfoSchema.safeParse(info).success, true);
      }
      assert.strictEqual(OSInfoSchema.safeParse({ platform: "darwin" }).success, false);
    });
  });
});
