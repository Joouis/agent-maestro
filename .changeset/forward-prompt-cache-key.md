---
"agent-maestro": patch
---

Forward OpenAI `prompt_cache_key` to Copilot as the conversation ID so GPT models can reuse the prompt cache. Cache hits (non-zero `cached_tokens`) depend on Copilot's `chat.responsesApi.promptCacheKey.enabled` experiment being active.
