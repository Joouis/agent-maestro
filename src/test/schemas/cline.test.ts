import * as assert from "assert";

import {
  ImagesDataUriSchema,
  ClineMessageRequestSchema,
  ClineTaskResponseSchema,
} from "../../server/schemas/cline";

suite("Cline Schemas Test Suite", () => {
  suite("ImagesDataUriSchema", () => {
    test("should accept valid inputs", () => {
      const validImages = [
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      ];
      assert.strictEqual(ImagesDataUriSchema.safeParse(validImages).success, true);
      assert.strictEqual(ImagesDataUriSchema.safeParse([]).success, true);
      assert.strictEqual(ImagesDataUriSchema.safeParse(undefined).success, true);
    });

    test("should reject invalid inputs", () => {
      const invalidCases = [
        ["data:text/plain;base64,SGVsbG8="],
        ["data:image/png,rawdata"],
        ["https://example.com/image.png"],
        ["/path/to/image.png"],
      ];
      for (const invalid of invalidCases) {
        assert.strictEqual(ImagesDataUriSchema.safeParse(invalid).success, false);
      }
    });
  });

  suite("ClineMessageRequestSchema", () => {
    test("should accept valid requests", () => {
      assert.strictEqual(
        ClineMessageRequestSchema.safeParse({ text: "Hello" }).success,
        true,
      );
      assert.strictEqual(
        ClineMessageRequestSchema.safeParse({
          text: "Describe",
          images: ["data:image/png;base64,abc="],
        }).success,
        true,
      );
    });

    test("should reject invalid requests", () => {
      assert.strictEqual(
        ClineMessageRequestSchema.safeParse({ images: [] }).success,
        false,
      );
      assert.strictEqual(
        ClineMessageRequestSchema.safeParse({ text: "" }).success,
        false,
      );
      assert.strictEqual(
        ClineMessageRequestSchema.safeParse({ text: "Hi", images: ["invalid"] }).success,
        false,
      );
    });
  });

  suite("ClineTaskResponseSchema", () => {
    test("should accept all valid statuses", () => {
      for (const status of ["created", "running", "completed", "failed"]) {
        const result = ClineTaskResponseSchema.safeParse({
          id: "task-1",
          status,
          message: "msg",
        });
        assert.strictEqual(result.success, true, `Status ${status} should be valid`);
      }
    });

    test("should reject invalid responses", () => {
      assert.strictEqual(
        ClineTaskResponseSchema.safeParse({ id: "1", status: "unknown", message: "m" }).success,
        false,
      );
      assert.strictEqual(
        ClineTaskResponseSchema.safeParse({ status: "created", message: "m" }).success,
        false,
      );
      assert.strictEqual(
        ClineTaskResponseSchema.safeParse({ id: "1", status: "created" }).success,
        false,
      );
    });
  });
});
