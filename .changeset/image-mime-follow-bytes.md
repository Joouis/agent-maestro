---
"agent-maestro": patch
---

Fix Anthropic tool-result images being rejected as a media-type mismatch when large JPEG/WebP bytes were relabeled as PNG. Top-level image parts still keep the VS Code resize workaround, while nested tool-result images now preserve their declared media type.
