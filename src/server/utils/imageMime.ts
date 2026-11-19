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

const CANONICAL_IMAGE_MIMES = new Set<string>(Object.values(TYPE_TO_MIME));

const IMAGE_MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/x-ms-bmp": "image/bmp",
};

export interface ImageMimeOptions {
  /**
   * When true, skip relabeling large (>768x768) images to `image/png` while
   * still sniffing the true format from image bytes (or falling back to the
   * canonicalized declared MIME when dimensions cannot be read). Use for
   * tool-result image parts that are not passed through the top-level
   * user-image PNG re-encode path.
   */
  preserveMimeType?: boolean;
}

/**
 * Normalize a declared image MIME string (trim, lowercase, strip media-type
 * parameters such as `;charset=utf-8`, and map common aliases like `image/jpg`
 * to `image/jpeg`). Returns `undefined` when the normalized value is not in
 * the supported canonical image MIME set.
 */
export function canonicalizeImageMime(mime: string): string | undefined {
  const baseMime = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const mapped = IMAGE_MIME_ALIASES[baseMime] ?? baseMime;
  return CANONICAL_IMAGE_MIMES.has(mapped) ? mapped : undefined;
}

function toBufferView(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

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
 * 2. The VS Code LM API re-encodes large top-level images to PNG on the way to
 *    the provider but leaves the label untouched, and only when BOTH sides
 *    exceed 768px (the early-return is `(width <= 768 || height <= 768)`).
 *
 * So, using the sniffed true format as the baseline:
 *   - both sides > 768px (when `options.preserveMimeType` is not set) →
 *     `image/png` (VS Code re-encodes top-level images to PNG)
 *   - otherwise (including all tool-result images with `preserveMimeType: true`) →
 *     the sniffed true canonical mimeType (correcting mislabeled bytes while
 *     preserving the real format for large tool-result images)
 *   - bytes not recognizable as an image → fall back to the canonicalized or
 *     declared mimeType
 *
 * The re-encode half is a workaround for a VS Code bug; revisit once that ships
 * a fix that preserves the source format (or updates the label to match).
 */
export function mimeForVscodeLm(
  bytes: Uint8Array,
  originalMime: string,
  options: ImageMimeOptions = {},
): string {
  const fallbackMime = canonicalizeImageMime(originalMime) ?? originalMime;
  let dimensions:
    | { width?: number; height?: number; type?: string }
    | undefined;
  try {
    dimensions = imageSize(toBufferView(bytes));
  } catch {
    logger.warn(
      `Failed to read image dimensions, keeping mime ${fallbackMime}`,
    );
    dimensions = undefined;
  }

  if (!dimensions?.width || !dimensions?.height) {
    return fallbackMime;
  }

  if (
    !options.preserveMimeType &&
    dimensions.width > 768 &&
    dimensions.height > 768
  ) {
    return "image/png";
  }

  // Pass-through case: trust the sniffed bytes over the caller's label.
  return (dimensions.type && TYPE_TO_MIME[dimensions.type]) || fallbackMime;
}
