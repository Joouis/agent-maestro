import { imageSize } from "image-size";

import { logger } from "../../utils/logger";

/** Canonical image MIME type for each format `image-size` reports. */
const TYPE_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/**
 * Sniff the true image format from the leading magic bytes.
 *
 * Each signature is length-checked independently so short-but-valid buffers
 * (a 3-byte JPEG/GIF header, a 2-byte BMP header) are still recognized; only
 * WebP needs the full 12-byte `RIFF....WEBP` prefix. Returns `undefined` when
 * the buffer matches no known signature.
 */
function sniffMimeFromBytes(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 2) {
    return undefined;
  }

  const at = (i: number, v: number) => buffer.length > i && buffer[i] === v;

  // JPEG: FF D8 FF
  if (at(0, 0xff) && at(1, 0xd8) && at(2, 0xff)) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47
  if (at(0, 0x89) && at(1, 0x50) && at(2, 0x4e) && at(3, 0x47)) {
    return "image/png";
  }
  // GIF: 47 49 46
  if (at(0, 0x47) && at(1, 0x49) && at(2, 0x46)) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    at(0, 0x52) &&
    at(1, 0x49) &&
    at(2, 0x46) &&
    at(3, 0x46) &&
    at(8, 0x57) &&
    at(9, 0x45) &&
    at(10, 0x42) &&
    at(11, 0x50)
  ) {
    return "image/webp";
  }
  // BMP: 42 4D
  if (at(0, 0x42) && at(1, 0x4d)) {
    return "image/bmp";
  }

  return undefined;
}

/**
 * Pick the mimeType to attach to a VS Code `LanguageModelDataPart` for an image.
 *
 * The emitted label MUST match the bytes we actually forward, because providers
 * that sniff the payload (Anthropic) reject any byte/label mismatch ("specified
 * image/png, but the image appears to be image/jpeg").
 *
 * Because the bytes are forwarded unchanged, the label simply follows them:
 *   1. magic-byte signature (most reliable) — used whenever recognized;
 *   2. otherwise the format reported by `image-size`;
 *   3. otherwise fall back to the declared mimeType.
 *
 * HISTORY: an earlier version force-labeled any image whose width AND height
 * exceeded 768px as `image/png`, to match a VS Code LM API defect that
 * re-encoded large images to PNG (`mainThreadLanguageModels.ts` ->
 * `resizeImage`, called with no source mimeType) while leaving the label
 * untouched. VS Code's `resizeImage` now preserves the source format when a
 * mimeType is supplied, and observed builds no longer produce the PNG bytes for
 * large JPEG/WebP, so force-labeling to PNG became a NEW mismatch (PNG label on
 * JPEG bytes). We therefore follow the real bytes unconditionally. If a VS Code
 * build is ever found to still re-encode large images to PNG on this path, the
 * correct fix is to transcode the buffer to PNG here, not to relabel it.
 */
export function mimeForVscodeLm(buffer: Buffer, originalMime: string): string {
  const sniffed = sniffMimeFromBytes(buffer);
  if (sniffed) {
    return sniffed;
  }

  let dimensions:
    | { width?: number; height?: number; type?: string }
    | undefined;
  try {
    dimensions = imageSize(buffer);
  } catch {
    logger.warn(
      `Failed to read image dimensions, keeping mime ${originalMime}`,
    );
    dimensions = undefined;
  }

  return (dimensions?.type && TYPE_TO_MIME[dimensions.type]) || originalMime;
}
