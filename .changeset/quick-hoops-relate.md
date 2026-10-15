---
"agent-maestro": minor
---

Preserve encrypted Responses reasoning across tool continuations on compatible VS Code runtimes without proposed API declarations. Keep reasoning IDs unique and preserve source order in JSON/SSE output and replayed tool history.

Non-streaming Responses output now splits text around tool calls into separate message items in source order, instead of concatenating it into a single message before the tool calls. Clients that assume one message per response should process the full output array in order.
