import * as assert from "assert";

import { constantTimeEqual } from "../utils/crypto";

suite("Crypto Utility Test Suite", () => {
  suite("constantTimeEqual", () => {
    test("should return true for identical strings", () => {
      const str1 = "mySecretApiKey123";
      const str2 = "mySecretApiKey123";

      assert.strictEqual(constantTimeEqual(str1, str2), true);
    });

    test("should return false for different strings", () => {
      const str1 = "mySecretApiKey123";
      const str2 = "differentApiKey456";

      assert.strictEqual(constantTimeEqual(str1, str2), false);
    });

    test("should return false for strings with different lengths", () => {
      const str1 = "short";
      const str2 = "muchlongerstring";

      assert.strictEqual(constantTimeEqual(str1, str2), false);
    });

    test("should return false for strings that differ by one character", () => {
      const str1 = "mySecretApiKey123";
      const str2 = "mySecretApiKey124";

      assert.strictEqual(constantTimeEqual(str1, str2), false);
    });

    test("should return false for strings that differ in case", () => {
      const str1 = "mySecretApiKey";
      const str2 = "MySecretApiKey";

      assert.strictEqual(constantTimeEqual(str1, str2), false);
    });

    test("should handle empty strings", () => {
      assert.strictEqual(constantTimeEqual("", ""), true);
      assert.strictEqual(constantTimeEqual("", "nonempty"), false);
      assert.strictEqual(constantTimeEqual("nonempty", ""), false);
    });

    test("should handle unicode characters", () => {
      const str1 = "hello🔑world";
      const str2 = "hello🔑world";
      const str3 = "hello🗝️world";

      assert.strictEqual(constantTimeEqual(str1, str2), true);
      assert.strictEqual(constantTimeEqual(str1, str3), false);
    });

    test("should handle strings with special characters", () => {
      const str1 = "api-key_with.special!chars@123";
      const str2 = "api-key_with.special!chars@123";
      const str3 = "api-key_with.special!chars@124";

      assert.strictEqual(constantTimeEqual(str1, str2), true);
      assert.strictEqual(constantTimeEqual(str1, str3), false);
    });

    test("should handle whitespace differences", () => {
      const str1 = "api key";
      const str2 = "api key";
      const str3 = "apikey";

      assert.strictEqual(constantTimeEqual(str1, str2), true);
      assert.strictEqual(constantTimeEqual(str1, str3), false);
    });

    test("should handle strings with different UTF-8 byte lengths correctly", () => {
      // ASCII character (1 byte in UTF-8)
      const str1 = "a";
      // Latin character with diacritic (2 bytes in UTF-8)
      const str2 = "é";
      // CJK character (3 bytes in UTF-8)
      const str3 = "中";
      // Emoji (4 bytes in UTF-8)
      const str4 = "😀";

      // Same characters should be equal
      assert.strictEqual(constantTimeEqual(str1, str1), true);
      assert.strictEqual(constantTimeEqual(str2, str2), true);
      assert.strictEqual(constantTimeEqual(str3, str3), true);
      assert.strictEqual(constantTimeEqual(str4, str4), true);

      // Different characters should not be equal
      assert.strictEqual(constantTimeEqual(str1, str2), false);
      assert.strictEqual(constantTimeEqual(str2, str3), false);
      assert.strictEqual(constantTimeEqual(str3, str4), false);
    });

    test("should handle very long strings", () => {
      const longStr1 = "a".repeat(10000);
      const longStr2 = "a".repeat(10000);
      const longStr3 = "a".repeat(9999) + "b";

      assert.strictEqual(constantTimeEqual(longStr1, longStr2), true);
      assert.strictEqual(constantTimeEqual(longStr1, longStr3), false);
    });
  });
});
