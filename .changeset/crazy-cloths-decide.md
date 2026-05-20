---
"agent-maestro": patch
---

Use Copilot usage metadata from VS Code language model responses to report Anthropic-compatible input, output, and prompt cache token counts, with the previous token estimation path retained for count_tokens and fallback usage. Also raise the minimum VS Code engine to `^1.120.0`.
