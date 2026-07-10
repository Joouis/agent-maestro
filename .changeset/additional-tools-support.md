---
"agent-maestro": minor
---

Support OpenAI Responses API `additional_tools`, `custom`, and `namespace` tool types (used by Codex/GPT-5.6). Custom tools round-trip as `custom_tool_call` items with raw string input, and namespaced tools preserve their `namespace` field across the VSCode LM boundary via an encoded-name mapping table. `tool_choice: { type: "custom" }` is now enforced as required.
