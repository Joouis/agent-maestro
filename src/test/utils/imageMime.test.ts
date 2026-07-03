import * as assert from "assert";

import { mimeForVscodeLm } from "../../server/utils/imageMime";
import { JPEG_50x50_BASE64, WEBP_1024x935_BASE64 } from "./imageMime.fixtures";

/**
 * Build a minimal PNG header (8-byte signature + IHDR chunk) with a forged
 * width/height so `image-size` reports exactly those dimensions. CRC bytes are
 * left zero — this is not a spec-valid PNG, just enough for `image-size` to
 * parse. Lets the 768px boundary be tested without large fixtures.
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

      test("keeps mime for a small JPEG (50x50)", () => {
        // The JPEG bytes are forwarded unchanged, so the label stays image/jpeg.
        assert.strictEqual(mimeForVscodeLm(jpeg, "image/jpeg"), "image/jpeg");
      });

      test("keeps mime for a large WebP (1024x935, both sides > 768)", () => {
        // The bytes are forwarded unchanged, so the label follows them
        // regardless of size — VS Code no longer re-encodes to PNG here.
        assert.strictEqual(mimeForVscodeLm(webp, "image/webp"), "image/webp");
      });

      test("fixtures decode to the expected formats", () => {
        // Guards against a corrupted/edited fixture silently changing the
        // assertions above. ff d8 ff = JPEG, 52 49 46 46 = RIFF/WebP.
        assert.strictEqual(jpeg.subarray(0, 3).toString("hex"), "ffd8ff");
        assert.strictEqual(webp.subarray(0, 4).toString("hex"), "52494646");
      });
    });

    suite("GIF (label follows the real bytes)", () => {
      test("keeps mime for a small GIF", () => {
        assert.strictEqual(
          mimeForVscodeLm(makeGif(640, 480), "image/gif"),
          "image/gif",
        );
      });

      test("keeps mime for a large GIF (both sides > 768)", () => {
        // Size no longer changes the label; the GIF bytes pass through as-is.
        assert.strictEqual(
          mimeForVscodeLm(makeGif(1024, 900), "image/gif"),
          "image/gif",
        );
      });

      test("keeps mime for a tiny 1x1 GIF", () => {
        assert.strictEqual(
          mimeForVscodeLm(makeGif(1, 1), "image/gif"),
          "image/gif",
        );
      });
    });

    suite("size does not change the label (bytes decide)", () => {
      // The label follows the forwarded bytes regardless of dimensions, so a
      // PNG stays image/png at any size. These guard against a size-based
      // relabel branch being reintroduced.
      test("keeps png when both sides exceed 768", () => {
        assert.strictEqual(
          mimeForVscodeLm(makePng(769, 769), "image/png"),
          "image/png",
        );
      });

      test("keeps png when both sides are exactly 768", () => {
        assert.strictEqual(
          mimeForVscodeLm(makePng(768, 768), "image/png"),
          "image/png",
        );
      });

      test("keeps png for wide-but-short images", () => {
        assert.strictEqual(
          mimeForVscodeLm(makePng(4000, 500), "image/png"),
          "image/png",
        );
      });

      test("keeps png for tall-but-narrow images", () => {
        assert.strictEqual(
          mimeForVscodeLm(makePng(500, 4000), "image/png"),
          "image/png",
        );
      });

      test("keeps a real small JPEG as image/jpeg (pass-through)", () => {
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

      test("large mislabeled image follows its real bytes (byte sniffing wins)", () => {
        // A large PNG mislabeled as jpeg is still image/png: the bytes decide.
        assert.strictEqual(
          mimeForVscodeLm(makePng(1000, 1000), "image/jpeg"),
          "image/png",
        );
      });

      test("sniffs a short-but-valid JPEG header (fewer than 12 bytes)", () => {
        // Signature detection must not require a full 12-byte prefix; a 3-byte
        // JPEG header mislabeled as png must still resolve to image/jpeg.
        const shortJpeg = Buffer.from([0xff, 0xd8, 0xff]);
        assert.strictEqual(
          mimeForVscodeLm(shortJpeg, "image/png"),
          "image/jpeg",
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
