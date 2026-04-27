---
"agent-maestro": patch
---

Fix multi-turn Gemini tool calls failing with `the number of function response parts is equal to the number of function call parts of the function call turn`. `langchain-google-genai` 4.x emits `functionResponse` parts with only `name` (no `id`), relying on Gemini's positional pairing rules; the previous strict id check dropped those parts entirely. The converter now walks all parts in document order, assigns a stable `callId` to every `functionCall`, and uses a per-name FIFO queue to recover the matching `callId` when a `functionResponse` arrives without one.
