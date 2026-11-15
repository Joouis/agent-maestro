---
"agent-maestro": patch
---

Return HTTP 400 `invalid_request_error` instead of a 500 internal error when `model` is missing, empty, or not a string on Anthropic `/v1/messages` and `/v1/messages/count_tokens` and OpenAI `/v1/chat/completions`.
