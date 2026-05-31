---
"agent-maestro": minor
---

Add `agent-maestro.anthropic.contextWindowScaleFactor` setting to scale the `max_input_tokens` reported for Anthropic models. Lowering it below 1 makes Claude Code compact context earlier, mirroring the existing `agent-maestro.codex.contextWindowScaleFactor` option.
