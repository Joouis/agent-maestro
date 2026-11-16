---
"agent-maestro": patch
---

Normalize complex JSON Schema constructs (`$ref`/`$defs`, nullable type arrays, array-level `enum`s, and large discriminated `items.anyOf` unions) in tool input schemas before forwarding requests to VS Code Copilot language models, preventing Gemini `/chat/completions` backends from rejecting MCP tool definitions with `400 invalid_request_body`.
