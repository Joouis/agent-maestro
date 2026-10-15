---
"agent-maestro": minor
---

Preserve encrypted reasoning across OpenAI Responses tool continuations, including streaming, on compatible VS Code hosts. Responses now keep text and tool calls in their original order, so clients should process the full output array rather than assume a single message.
