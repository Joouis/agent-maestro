---
"agent-maestro": patch
---

fix: handle image blocks inside Anthropic `tool_result` content arrays

`toolResultBlockParamToVSCodePart` previously stringified non-text content blocks via `JSON.stringify(c)`. When a tool_result contains an image (e.g. Claude Code's `Read` tool returning a binary image file), the base64 payload reached the Language Model as serialized JSON text instead of a `LanguageModelDataPart`, causing the model to receive no image data and hallucinate. Top-level user-message images were already routed correctly via `imageBlockParamToVSCodePart`; this change uses the same converter for tool_result images.
