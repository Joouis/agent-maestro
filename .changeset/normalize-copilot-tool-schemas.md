---
"agent-maestro": patch
---

Normalize MCP tool parameter schemas for Copilot Gemini models when they declare array-level `enum`s, combine `anyOf`/`oneOf` with sibling `type`/`properties`/`required` on the same node, or use boolean property schemas (`true`), preventing upstream Gemini `/chat/completions` from rejecting tool definitions with `400 invalid_request_body`.
