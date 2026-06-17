import * as assert from "assert";

import { mimeForVscodeLm } from "../../server/utils/imageMime";
import { JPEG_50x50_BASE64, WEBP_1024x935_BASE64 } from "./imageMime.fixtures";

/**
 * Build a minimal valid PNG (8-byte signature + IHDR chunk) with a forged
 * width/height so `image-size` reports exactly those dimensions. Lets the 768px
 * boundary be tested without large fixtures.
 */
function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // chunk length
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // color type (truecolor)
  return Buffer.concat([signature, ihdr]);
}

/**
 * A minimal valid 1x1 GIF89a, used as the base for `makeGif`. The logical
 * screen width/height live at bytes 6-9 (little-endian).
 */
const BASE_GIF_1x1 = Buffer.from(
  "R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

/**
 * Clone the base GIF and overwrite its logical-screen dimensions so
 * `image-size` reports the requested width/height. Lets GIF size-gate behavior
 * be tested without a large real GIF fixture.
 */
function makeGif(width: number, height: number): Buffer {
  const gif = Buffer.from(BASE_GIF_1x1);
  gif.writeUInt16LE(width, 6);
  gif.writeUInt16LE(height, 8);
  return gif;
}

suite("imageMime Test Suite", () => {
  suite("mimeForVscodeLm", () => {
    suite("real image fixtures", () => {
      const jpeg = Buffer.from(JPEG_50x50_BASE64, "base64");
      const webp = Buffer.from(WEBP_1024x935_BASE64, "base64");

      test("keeps mime for a small JPEG (50x50, below the 768 gate)", () => {
        // VS Code passes images <=768 on a side through verbatim, so the
        // original JPEG bytes survive and the label must stay image/jpeg.
        assert.strictEqual(mimeForVscodeLm(jpeg, "image/jpeg"), "image/jpeg");
      });

      test("relabels a large WebP (1024x935, both sides > 768) to png", () => {
        // Both dimensions exceed 768, so VS Code re-encodes to PNG via
        // canvas.toBlob; the label must follow the bytes to image/png.
        assert.strictEqual(mimeForVscodeLm(webp, "image/webp"), "image/png");
      });

      test("fixtures decode to the expected formats", () => {
        // Guards against a corrupted/edited fixture silently changing the
        // assertions above. ff d8 ff = JPEG, 52 49 46 46 = RIFF/WebP.
        assert.strictEqual(jpeg.subarray(0, 3).toString("hex"), "ffd8ff");
        assert.strictEqual(webp.subarray(0, 4).toString("hex"), "52494646");
      });
    });

    suite("GIF (size-gated like other formats on the LM API path)", () => {
      // The LM API path calls resizeImage() WITHOUT a mimeType, so VS Code's
      // `isGif` branch never fires and GIFs follow the same 768 gate as
      // everything else — small GIFs are NOT re-encoded.
      test("keeps mime for a small GIF (a side <= 768)", () => {
        assert.strictEqual(
          mimeForVscodeLm(makeGif(640, 480), "image/gif"),
          "image/gif",
        );
      });

      test("relabels a large GIF (both sides > 768) to png", () => {
        // Large GIF is re-encoded to a single-frame PNG; the label follows.
        assert.strictEqual(
          mimeForVscodeLm(makeGif(1024, 900), "image/gif"),
          "image/png",
        );
      });

      test("keeps mime for a tiny 1x1 GIF", () => {
        assert.strictEqual(
          mimeForVscodeLm(makeGif(1, 1), "image/gif"),
          "image/gif",
        );
      });
    });

    suite("768px boundary (the VS Code re-encode gate)", () => {
      // These use PNG bytes with a matching image/png label so the assertions
      // isolate the size gate from the byte-sniffing in the mislabel suite.
      test("relabels to png when both sides exceed 768", () => {
        assert.strictEqual(
          mimeForVscodeLm(makePng(769, 769), "image/png"),
          "image/png",
        );
      });

      test("keeps mime when both sides are exactly 768", () => {
        // VS Code's gate is `width <= 768 || height <= 768` (inclusive), so
        // 768 is the pass-through case, not the re-encode case.
        assert.strictEqual(
          mimeForVscodeLm(makePng(768, 768), "image/png"),
          "image/png",
        );
      });

      test("does not re-encode wide-but-short images (one side <= 768)", () => {
        // 4000x500: VS Code's `||` gate passes it through untouched because
        // height <= 768, so it must NOT be relabeled to png-via-re-encode.
        assert.strictEqual(
          mimeForVscodeLm(makePng(4000, 500), "image/png"),
          "image/png",
        );
      });

      test("does not re-encode tall-but-narrow images (one side <= 768)", () => {
        assert.strictEqual(
          mimeForVscodeLm(makePng(500, 4000), "image/png"),
          "image/png",
        );
      });

      test("keeps a real small JPEG as image/jpeg (pass-through)", () => {
        // Bytes and label agree: a small JPEG must survive as image/jpeg, not
        // be coerced to png. Guards the wide/tall cases above from silently
        // passing only because the bytes happened to be png.
        const jpeg = Buffer.from(JPEG_50x50_BASE64, "base64");
        assert.strictEqual(mimeForVscodeLm(jpeg, "image/jpeg"), "image/jpeg");
      });
    });

    suite("corrects already-mislabeled bytes (byte sniffing)", () => {
      test("small PNG mislabeled as jpeg → image/png", () => {
        // A client may send PNG bytes under an image/jpeg label. The image is
        // small so VS Code ships the PNG bytes verbatim; the label must follow
        // the bytes, otherwise Anthropic rejects the jpeg-label + png-bytes.
        assert.strictEqual(
          mimeForVscodeLm(makePng(50, 50), "image/jpeg"),
          "image/png",
        );
      });

      test("small JPEG mislabeled as png → image/jpeg", () => {
        const jpeg = Buffer.from(JPEG_50x50_BASE64, "base64");
        assert.strictEqual(mimeForVscodeLm(jpeg, "image/png"), "image/jpeg");
      });

      test("normalizes the sniffed type to a canonical mime (jpg → image/jpeg)", () => {
        // image-size reports "jpg"; the helper must emit canonical image/jpeg.
        const jpeg = Buffer.from(JPEG_50x50_BASE64, "base64");
        assert.strictEqual(
          mimeForVscodeLm(jpeg, "application/octet-stream"),
          "image/jpeg",
        );
      });

      test("large mislabeled image is png regardless of label (re-encode wins)", () => {
        // Re-encode path: both sides > 768 → png no matter the incoming label.
        assert.strictEqual(
          mimeForVscodeLm(makePng(1000, 1000), "image/jpeg"),
          "image/png",
        );
      });
    });

    suite("unreadable dimensions fallback", () => {
      test("keeps the original mime when the buffer is not a valid image", () => {
        // image-size throws on garbage; the helper must fall back to the
        // original mime rather than guessing PNG.
        const garbage = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
        assert.strictEqual(
          mimeForVscodeLm(garbage, "image/jpeg"),
          "image/jpeg",
        );
      });

      test("keeps the original mime for an empty buffer", () => {
        assert.strictEqual(
          mimeForVscodeLm(Buffer.alloc(0), "image/webp"),
          "image/webp",
        );
      });
    });
  });
});
