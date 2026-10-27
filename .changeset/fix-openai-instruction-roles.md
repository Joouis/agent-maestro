---
"agent-maestro": patch
---

Preserve OpenAI Responses instructions and Chat/Responses system and developer messages as VS Code System messages, including through tool-history normalization. This prevents instruction-role downgrading that can suppress Codex progress updates. Requires the VS Code languageModelSystem proposed API to be enabled; system and developer share its single instruction role.
