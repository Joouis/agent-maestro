---
"agent-maestro": minor
---

Add OpenAI-compatible model list (`GET /api/openai/v1/models`) and exact retrieval (`GET /api/openai/v1/models/{model_id}`) endpoints for proxy-eligible Copilot models, reporting discovery failures as structured HTTP 500 errors instead of empty lists.
