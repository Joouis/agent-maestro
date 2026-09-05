---
"agent-maestro": patch
---

Fix Codex Responses SSE idle timeouts by sending JSON keepalive events during model startup, generation, web search, and token counting without replacing the OpenAI SDK's accumulated response.
