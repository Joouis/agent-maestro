---
"agent-maestro": patch
---

Gemini `generateContent` now times out with `504 DEADLINE_EXCEEDED` and stops with 499 when the client disconnects, cancelling the language model request in both cases, matching the streaming and other model routes. Previously a stalled non-streaming Gemini request could hang indefinitely.
