---
"agent-maestro": patch
---

Fix `/v1/chat/completions` failing with `Unexpected chat message content type llm 2` when the OpenAI client sends a `system` or `developer` message whose content is an array of text blocks (deepagents, langchain-openai, etc. do this when splitting long system prompts). The converter previously mapped each block to a bare `{ value: text }` object, which Copilot Chat's `_convertMessages` does not accept. Each block is now wrapped in `LanguageModelTextPart`, mirroring the user-role branch.
