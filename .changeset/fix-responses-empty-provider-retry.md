---
"agent-maestro": patch
---

Retry Copilot's `Response contained no choices.` error once for OpenAI Responses requests before committing model output. Buffer opaque-only encrypted reasoning until other output arrives or the attempt succeeds, discarding failed attempts' buffered state. Keep the original timeout, cancellation, and streaming heartbeats active, and never replay text, tools, visible thinking, usage, or unknown parts. Apply the same recovery to hosted web-search model rounds without repeating completed searches.
