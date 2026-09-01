---
"agent-maestro": patch
---

Recover Codex Responses sessions when Copilot rejects previously paired tool history after downstream truncation (#245). Agent Maestro retries once with historical tool calls and results preserved as ordinary context, and never retries after model output has started.
