---
"agent-maestro": patch
---

Fix OpenAI Responses custom tools being advertised without an input schema to
VS Code language models. Require the raw string `input` wrapper used by replayed
history and preserve namespace instructions when flattening tool declarations,
including Codex code-execution tools.
