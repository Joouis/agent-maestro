---
"agent-maestro": patch
---

Remove the `agent-maestro.codex.contextWindowScaleFactor` setting. `Configure Codex Settings` command now writes `model_context_window` to Codex's `config.toml` directly from the selected model's reported `maxInputTokens`. To customize the window, edit `model_context_window` in `~/.codex/config.toml`.
