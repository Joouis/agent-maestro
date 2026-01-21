---
"agent-maestro": minor
---

Add fuzzy model matching using Jaccard similarity

- Match model IDs with date suffixes to available models (e.g., `claude-opus-4-5-20251101` → `claude-opus-4.5`)
- Warn when no Claude models found (VPN/network issue hint)
- Add error hints for `model_not_supported` errors
- Improve logging format (→ request, ← response, ✕ error)
