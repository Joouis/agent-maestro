---
"agent-maestro": patch
---

Remove the `agent-maestro.anthropic.tokenCountScaleFactor` setting. Fallback Anthropic token estimates and `/messages/count_tokens` responses are now reported using VS Code's raw token count instead of a configurable 1.25× multiplier. To make Claude Code compact context earlier, use its `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env vars — rerun **Agent Maestro: Configure Claude Code Settings** to have these written for you.
