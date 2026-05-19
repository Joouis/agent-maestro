---
"@fake-scope/fake-pkg": patch
---

Set `CLAUDE_CODE_ATTRIBUTION_HEADER=0` in generated Claude Code `settings.json` to disable the `x-anthropic-billing-header` (CCH), which can break prompt caching on non-Anthropic LLM gateways. See https://code.claude.com/docs/en/llm-gateway.
