---
"agent-maestro": patch
---

Preserve original image MIME types in OpenAI Responses `function_call_output` and `custom_tool_call_output` items so large JPEG tool results are not re-encoded as oversized PNGs.
