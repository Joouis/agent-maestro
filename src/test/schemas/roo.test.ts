import * as assert from "assert";

import {
  ProviderSettingsSchema,
  ProviderSettingsEntrySchema,
  CreateProfileRequestSchema,
  RooMessageRequestSchema,
  RooActionRequestSchema,
  HistoryItemSchema,
  RooTaskResponseSchema,
} from "../../server/schemas/roo";

suite("Roo Schemas Test Suite", () => {
  suite("ProviderSettingsSchema", () => {
    test("should validate provider settings", () => {
      // Valid providers
      assert.strictEqual(
        ProviderSettingsSchema.safeParse({ apiProvider: "anthropic", apiKey: "sk-..." }).success,
        true,
      );
      assert.strictEqual(
        ProviderSettingsSchema.safeParse({ apiProvider: "openai", apiModelId: "gpt-4" }).success,
        true,
      );
      assert.strictEqual(
        ProviderSettingsSchema.safeParse({ apiProvider: "vscode-lm" }).success,
        true,
      );
      assert.strictEqual(ProviderSettingsSchema.safeParse({}).success, true);

      // Invalid
      assert.strictEqual(
        ProviderSettingsSchema.safeParse({ apiProvider: "invalid" }).success,
        false,
      );
      assert.strictEqual(
        ProviderSettingsSchema.safeParse({ reasoningEffort: "extreme" }).success,
        false,
      );
    });
  });

  suite("ProviderSettingsEntrySchema", () => {
    test("should validate provider settings entries", () => {
      assert.strictEqual(
        ProviderSettingsEntrySchema.safeParse({ id: "p1", name: "Profile" }).success,
        true,
      );
      assert.strictEqual(
        ProviderSettingsEntrySchema.safeParse({ id: "p1", name: "P", apiProvider: "anthropic" }).success,
        true,
      );
      assert.strictEqual(ProviderSettingsEntrySchema.safeParse({ name: "P" }).success, false);
      assert.strictEqual(ProviderSettingsEntrySchema.safeParse({ id: "p1" }).success, false);
    });
  });

  suite("CreateProfileRequestSchema", () => {
    test("should validate create profile requests", () => {
      assert.strictEqual(
        CreateProfileRequestSchema.safeParse({ name: "My Profile" }).success,
        true,
      );
      assert.strictEqual(
        CreateProfileRequestSchema.safeParse({
          name: "Full",
          profile: { apiProvider: "anthropic" },
          activate: true,
        }).success,
        true,
      );
      assert.strictEqual(CreateProfileRequestSchema.safeParse({ name: "" }).success, false);
      assert.strictEqual(
        CreateProfileRequestSchema.safeParse({ profile: { apiProvider: "openai" } }).success,
        false,
      );
    });
  });

  suite("RooMessageRequestSchema", () => {
    test("should validate message requests", () => {
      assert.strictEqual(RooMessageRequestSchema.safeParse({ text: "Hello" }).success, true);
      assert.strictEqual(
        RooMessageRequestSchema.safeParse({
          text: "Hi",
          images: ["data:image/png;base64,abc="],
          newTab: true,
        }).success,
        true,
      );
      assert.strictEqual(RooMessageRequestSchema.safeParse({ text: "" }).success, false);
    });
  });

  suite("RooActionRequestSchema", () => {
    test("should validate action requests", () => {
      for (const action of ["pressPrimaryButton", "pressSecondaryButton", "cancel", "resume"]) {
        assert.strictEqual(RooActionRequestSchema.safeParse({ action }).success, true);
      }
      assert.strictEqual(RooActionRequestSchema.safeParse({ action: "invalid" }).success, false);
    });
  });

  suite("HistoryItemSchema", () => {
    test("should validate history items", () => {
      const validItem = {
        id: "t1",
        ts: 1704067200000,
        task: "Task",
        tokensIn: 100,
        tokensOut: 200,
        totalCost: 0.01,
      };
      assert.strictEqual(HistoryItemSchema.safeParse(validItem).success, true);
      assert.strictEqual(
        HistoryItemSchema.safeParse({ ...validItem, cacheWrites: 10, workspace: "/path" }).success,
        true,
      );
      assert.strictEqual(HistoryItemSchema.safeParse({ id: "t1", ts: 123 }).success, false);
    });
  });

  suite("RooTaskResponseSchema", () => {
    test("should validate task responses", () => {
      for (const status of ["created", "running", "completed", "failed"]) {
        assert.strictEqual(
          RooTaskResponseSchema.safeParse({ id: "t1", status, message: "m" }).success,
          true,
        );
      }
      assert.strictEqual(
        RooTaskResponseSchema.safeParse({ id: "t1", status: "pending", message: "m" }).success,
        false,
      );
    });
  });
});
