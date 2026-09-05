# VS Code LM API image MIME re-encode defect

Implementation note reviewed on 2026-09-05. The upstream behavior below records the defect behind the workaround, not a fresh verification of every VS Code release. Recheck it when changing the minimum VS Code version.

## Summary

The VS Code Language Model API silently re-encodes images to PNG when sending
them to a model provider, but does **not** update the part's declared MIME type.
Providers that validate image bytes against the declared type (notably Anthropic)
reject the request:

```text
messages.0.content.4.image.source.base64: The image was specified using the
image/jpeg media type, but the image appears to be a image/png image
```

This affects every proxy route that forwards images to Copilot vision models:
Anthropic (`/v1/messages`), OpenAI Chat, OpenAI Responses, and Gemini.

(The same error can also originate from a client that mislabels its bytes —
e.g. PNG data under an `image/jpeg` label. The workaround below handles both,
since both reduce to "declared type disagrees with bytes".)

## Root cause (VS Code side)

On the request path, `mainThreadLanguageModels.ts` runs every `image_url` part
through `resizeImage()` (`vs/workbench/contrib/chat/browser/chatImageUtils.ts`):

- `resizeImage(data)` is called **without** the source MIME type.
- With no MIME, the canvas re-encode always picks `image/png`
  (`outputMimeType = mimeType && jpegTypes.includes(mimeType) ? 'image/jpeg' : 'image/png'`).
- The part's `mimeType` field is left untouched at its original value.

The resize only triggers when **both** dimensions exceed 768px — the early
return is `(width <= 768 || height <= 768)`. This is uniform across formats on
the LM API path:

| Input               | VS Code behavior               | Result                        |
| ------------------- | ------------------------------ | ----------------------------- |
| Either side ≤ 768px | passes through verbatim        | label must match bytes        |
| Both sides > 768px  | re-encodes to PNG, keeps label | **mismatch unless relabeled** |

PNG inputs are unaffected because the forced PNG output happens to match the
PNG label. (`resizeImage()` has an `isGif` branch that re-encodes GIFs at any
size, but the LM API path never passes a mimeType, so it never fires here.)

## Workaround (this repo)

`src/server/utils/imageMime.ts` exports `mimeForVscodeLm(buffer, originalMime)`,
used by the top-level image converters across the four protocol adapters. It sniffs the real format from the
bytes (header-only, via `image-size`, which also yields the dimensions) and
returns:

- both sides > 768px → `image/png` (VS Code will re-encode it to PNG)
- otherwise → the **sniffed** true MIME type (the bytes pass through unchanged)
- bytes not recognizable as an image → fall back to the declared `originalMime`

Using the sniffed type for the pass-through case fixes a second, independent
source of mismatch: a client that mislabels the bytes (e.g. PNG bytes under an
`image/jpeg` label). Such an image, if small enough to skip VS Code's re-encode,
would otherwise ship the wrong label unchanged and be rejected. Trusting the
bytes over the caller's label corrects both that and the VS Code re-encode in
one rule.

This makes the declared type match the bytes the provider actually receives.

### Anthropic Tool-Result Exception

Images nested in Anthropic `tool_result` blocks take a different path: the
[Anthropic converter](../src/server/utils/anthropic.ts) passes
`preserveMimeType: true` and retains the declared MIME type. Applying the
top-level large-image relabeling there caused a mismatch and was corrected in
v2.9.7. Keep that exception when maintaining the workaround; do not assume all
`LanguageModelDataPart` instances undergo the same upstream transformation.

The current history normalizer also preserves these converted result parts when
they become ordinary context. Revalidate affected image paths separately if
conversion placement or upstream serialization changes.

## ⚠️ When VS Code fixes this, revisit the workaround

The **re-encode half** is coupled to the VS Code defect. If VS Code starts
preserving the source format (e.g. passing the MIME into `resizeImage`, or
re-encoding JPEG as JPEG), then forcing `image/png` for large JPEG/WebP becomes
a _new_ mismatch.

Check this whenever bumping the VS Code engine (`engines.vscode` in
`package.json`). If the upstream resize path preserves format, drop the
`width/height > 768 → image/png` branch. The **byte-sniffing half** (returning
the sniffed true type) is not VS Code-specific and should stay — it guards
against mislabeled client input regardless of the resize behavior.

Tests: `src/test/utils/imageMime.test.ts` (fixtures in `imageMime.fixtures.ts`).
