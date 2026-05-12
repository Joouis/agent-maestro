---
"agent-maestro": patch
---

Fix Anthropic `/v1/messages` length-truncated responses from VS Code/Copilot so partial content can be returned successfully with `stop_reason: "max_tokens"` instead of a 500 error.
