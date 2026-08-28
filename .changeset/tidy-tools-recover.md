---
"agent-maestro": patch
---

Keep Anthropic and Responses conversations usable after malformed compaction or replay by preserving orphaned tool results as ordinary context and dropping duplicate results before calling the VS Code Language Model API.
