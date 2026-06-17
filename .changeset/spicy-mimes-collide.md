---
"agent-maestro": patch
---

Fix images sent to Copilot vision models being rejected as a media-type mismatch (e.g. "specified image/jpeg, but the image appears to be image/png"). The VS Code Language Model API re-encodes images to PNG when both dimensions exceed 768px without updating their declared MIME type; Agent Maestro now relabels affected images so the type matches the bytes. Applies to the Anthropic, OpenAI Chat, OpenAI Responses, and Gemini routes.
