---
"agent-maestro": patch
---

Gemini models can now see images returned by tools. Tool-result images are moved into a following user message, where VS Code resizes them; previously Gemini ignored them, and large ones failed the request.
