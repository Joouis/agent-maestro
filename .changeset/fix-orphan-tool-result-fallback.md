---
"agent-maestro": patch
---

Refine `/v1/messages` orphan `tool_use_id` handling so a Copilot-side bug isn't silently translated to `model_context_window_exceeded`. Now: (1) malformed client requests with orphan `tool_result` blocks are rejected up-front with a 400 `invalid_request_error`; (2) downstream orphan errors that survive that pre-flight are translated to `model_context_window_exceeded` only when the calibrated input token count is at or over the model's `max_input_tokens` — i.e. when Copilot's internal truncation is the plausible cause. Below the cap, the original error is now re-raised so a Copilot-side bug (also seen by litellm users) stays visible to whoever owns the upstream fix. Adds dogfood-friendly logging of `error.code` and the error constructor at every orphan catch so a future PR can replace message-substring matching with a stable code-based check once we confirm what Copilot actually fills.
