---
"agent-maestro": patch
---

Fix images sent to Copilot vision models being rejected as a media-type mismatch (e.g. "specified image/png, but the image appears to be image/jpeg"). The image MIME label now always follows the real bytes (magic-byte sniff, then `image-size`, then the declared type) instead of force-labeling large images as PNG, which broke on VS Code builds that no longer re-encode large images to PNG. Signature detection also handles short-but-valid headers. Applies to the Anthropic, OpenAI Chat, OpenAI Responses, and Gemini routes.
