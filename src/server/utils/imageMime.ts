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
 * Pick the mimeType to attach to a VS Code `LanguageModelDataPart` for an image.
 *
 * Two problems are corrected here, both of which surface as a byte/label
 * mismatch that providers which sniff bytes (Anthropic) reject ("specified
 * image/jpeg, but the image appears to be image/png"):
 *
 * 1. The caller's declared mimeType may already disagree with the bytes (a
 *    client that mislabels a PNG as image/jpeg). We sniff the real format from
 *    the bytes and use that instead of trusting the incoming label.
 * 2. The VS Code LM API re-encodes large images to PNG on the way to the
 *    provider (`mainThreadLanguageModels.ts` → `resizeImage`) but leaves the
 *    label untouched. It calls `resizeImage` WITHOUT the source mimeType, so it
 *    always re-encodes to PNG, and only when BOTH sides exceed 768px (the
 *    early-return is `(width <= 768 || height <= 768)`).
 *
 * So, using the sniffed true format as the baseline:
 *   - both sides > 768px → `image/png` (VS Code re-encodes to PNG)
 *   - otherwise → the sniffed true mimeType (bytes pass through unchanged)
 *   - bytes not recognizable as an image → fall back to the declared mimeType
 *
 * This is uniform across formats on the LM API path, which passes no mimeType
 * to `resizeImage` (so VS Code's GIF special-case never fires here).
 *
 * The re-encode half is a workaround for a VS Code bug; revisit once that ships
 * a fix that preserves the source format (or updates the label to match).
 */
export function mimeForVscodeLm(buffer: Buffer, originalMime: string): string {
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

  if (!dimensions?.width || !dimensions?.height) {
    return originalMime;
  }

  if (dimensions.width > 768 && dimensions.height > 768) {
    return "image/png";
  }

  // Pass-through case: trust the sniffed bytes over the caller's label.
  return (dimensions.type && TYPE_TO_MIME[dimensions.type]) || originalMime;
}
