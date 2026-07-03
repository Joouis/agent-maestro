# VS Code LM API image MIME handling

## Summary

Providers that validate image bytes against the declared MIME type (notably
Anthropic vision) reject any request where the two disagree:

```
messages.0.content.4.image.source.base64: The image was specified using the
image/png media type, but the image appears to be a image/jpeg image
```

Two independent things can cause that mismatch on the proxy routes that forward
images to Copilot vision models (Anthropic `/v1/messages`, OpenAI Chat, OpenAI
Responses, Gemini):

1. A client mislabels its bytes (e.g. JPEG bytes under an `image/png` label).
2. Historically, the VS Code LM API re-encoded large images to PNG without
   updating the declared MIME type (see the version note below).

## Current behavior (this repo)

`src/server/utils/imageMime.ts` exports `mimeForVscodeLm(buffer, originalMime)`,
applied at all image-construction sites. It makes the declared type follow the
bytes we actually forward, since those bytes pass through unchanged:

1. sniff the real format from the leading magic bytes (JPEG/PNG/GIF/WebP/BMP) —
   the most reliable signal;
2. otherwise use the format reported by `image-size`;
3. otherwise fall back to the declared `originalMime`.

There is **no size-based relabeling**. The label is purely a function of the
bytes, which fixes the client-mislabel case at any size and never invents a
type the bytes don't have.

## History: the VS Code re-encode defect

Earlier, on the request path, `mainThreadLanguageModels.ts` ran every
`image_url` part through `resizeImage()`
(`vs/workbench/contrib/chat/browser/chatImageUtils.ts`) **without** the source
MIME type. With no MIME the canvas re-encode picked `image/png`, and the part's
`mimeType` field was left untouched — so a large JPEG/WebP arrived at the
provider as PNG bytes under a non-PNG label. The resize only triggered when
**both** dimensions exceeded 768px (early return `(width <= 768 || height <= 768)`).

To match that, `imageMime.ts` used to force `image/png` for any image with both
sides > 768px. That branch has been removed:

- VS Code's `resizeImage` now takes a `mimeType` and preserves the source format
  when one is supplied
  (`outputMimeType = mimeType && jpegTypes.includes(mimeType) ? 'image/jpeg' : 'image/png'`).
- On observed builds, large JPEG/WebP images are no longer delivered as PNG
  bytes on this path, so force-labeling to PNG produced a **new** mismatch
  (PNG label on JPEG bytes) — the exact failure this workaround exists to avoid.

## ⚠️ Version dependency — re-check when bumping `engines.vscode`

The upstream caller `mainThreadLanguageModels.ts` still invokes
`resizeImage(part.value.data.buffer)` **without** a mimeType on the LM API path.
Whether a given VS Code build actually re-encodes large images to PNG there
therefore depends on the exact build.

- If a build is found to **still** re-encode large images to PNG on this path,
  following the original bytes is wrong for those images. The correct fix is to
  **transcode the buffer to PNG** in `imageMime.ts` (so bytes and label are both
  PNG), **not** to relabel bytes we don't convert.
- The byte-sniffing itself is not VS Code-specific and should stay regardless —
  it guards against mislabeled client input.

Tests: `src/test/utils/imageMime.test.ts` (fixtures in `imageMime.fixtures.ts`).
