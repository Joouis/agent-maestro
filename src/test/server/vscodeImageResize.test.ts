import * as assert from "assert";

import { resizeImageForVscodeLm } from "../../server/utils/vscodeImageResize";

suite("VS Code LM image resize Test Suite", () => {
  test("keeps small images without invoking the renderer", async () => {
    const original = Buffer.alloc(32);
    let called = false;

    const result = await resizeImageForVscodeLm(
      original,
      "image/png",
      async () => {
        called = true;
        return Buffer.alloc(1);
      },
    );

    assert.strictEqual(called, false);
    assert.strictEqual(result.bytes, original);
    assert.strictEqual(result.mimeType, "image/png");
  });

  test("resizes large images with VS Code's renderer command", async () => {
    const original = Buffer.alloc(800 * 1024);
    const resized = Buffer.alloc(300 * 1024);
    let commandArgs: unknown[] = [];

    const result = await resizeImageForVscodeLm(
      original,
      "image/png",
      async (...args) => {
        commandArgs = args;
        return resized;
      },
    );

    assert.strictEqual(commandArgs[0], "_chat.resizeImage");
    assert.strictEqual(commandArgs[1], undefined);
    assert.strictEqual(commandArgs[2], original);
    assert.strictEqual(commandArgs[3], "image/jpeg");
    assert.deepStrictEqual(result.bytes, resized);
    assert.strictEqual(result.mimeType, "image/jpeg");
  });

  test("keeps the original if resizing fails", async () => {
    const original = Buffer.alloc(800 * 1024);
    const result = await resizeImageForVscodeLm(
      original,
      "image/jpeg",
      async () => {
        throw new Error("renderer unavailable");
      },
    );

    assert.strictEqual(result.bytes, original);
    assert.strictEqual(result.mimeType, "image/jpeg");
  });
});
