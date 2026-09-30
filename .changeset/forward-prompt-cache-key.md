---
"agent-maestro": patch
---

Forward OpenAI `prompt_cache_key` to Copilot as the conversation ID so GPT models can reuse the prompt cache (`cached_tokens` no longer stuck at 0).
