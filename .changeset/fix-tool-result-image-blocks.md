---
"agent-maestro": patch
---

fix: convert image blocks inside Anthropic tool_result content arrays

`toolResultBlockParamToVSCodePart` previously stringified non-text blocks via `JSON.stringify(c)`. When a tool result contains an image (e.g. Claude Code's Read tool returning a binary image file), the base64 payload was sent to the underlying Language Model as a JSON-serialized string instead of a `LanguageModelDataPart`, causing the model to hallucinate image content. Top-level user-message images were already handled correctly via `imageBlockParamToVSCodePart`; this PR routes tool_result images through the same converter.
