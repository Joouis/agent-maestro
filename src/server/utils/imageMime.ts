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
 * This is the most reliable signal we have and is independent of both the
 * caller's declared label and `image-size`'s dimension parsing. Returns
 * `undefined` when the buffer does not start with a recognized signature.
 */
function sniffMimeFromBytes(buffer: Buffer): string | undefined {
  if (!buffer || buffer.length < 12) {
    return undefined;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
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
 * We therefore trust the real bytes over the caller's declared label:
 *   1. magic-byte signature (most reliable) — used whenever recognized;
 *   2. otherwise the format reported by `image-size`;
 *   3. otherwise fall back to the declared mimeType.
 *
 * NOTE: An earlier version force-labeled any image whose width AND height
 * exceeded 768px as `image/png`, on the assumption that the VS Code LM API
 * re-encodes large images to PNG (`mainThreadLanguageModels.ts` →
 * `resizeImage`) while leaving the label untouched. That assumption no longer
 * holds — when VS Code does not re-encode, a large JPEG kept its JPEG bytes but
 * shipped with an `image/png` label, producing the exact mismatch above. Since
 * we do not transcode the bytes here, relabeling would always be a lie, so the
 * force-to-PNG branch has been removed. If large images genuinely need to be
 * PNG in the future, transcode the buffer rather than relabel it.
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
