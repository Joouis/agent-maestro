---
"agent-maestro": patch
---

Fix `/v1/messages` failing or hanging when Claude Code (or any client) sends Anthropic server-side tool definitions such as `web_search_20250305`, `computer_20250124`, `bash_20250124`, etc. The previous tool converter stuffed the entire tool object into `inputSchema`, producing invalid JSON Schema (`tools.0.custom.input_schema.type: Input should be 'object'`) and, when no upstream error surfaced, leaving the client waiting forever for a `tool_result` that VS Code's Language Model API cannot produce. These tools are now dropped with a logged warning so the model never sees them and the request proceeds normally. Fixes #163, addresses #150.
