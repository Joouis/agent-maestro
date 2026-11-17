---
"agent-maestro": patch
---

Recover from stale model handles that failed every request with `Chat provider for model … is not registered` (often after a restart when Copilot finishes loading after Agent Maestro). Cached models are now dropped when VS Code reports a model change, and a request that cannot start because its handle is stale re-resolves the same model once and retries; it never switches to a different model and never retries after output starts.
