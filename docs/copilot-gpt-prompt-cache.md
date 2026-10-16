# Copilot prompt-cache modes and GPT cache misses

GPT requests that Agent Maestro (AM) proxies to Copilot can report `cache_read: 0` on every turn, even when consecutive requests share a long identical prefix. The Copilot setting `github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled` controls how supported GPT models cache requests.

| Value   | Mode     | Behavior                                                                                                                                |
| ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `false` | Implicit | Matching prefixes can be cached automatically. Recommended for AM.                                                                      |
| `true`  | Explicit | Only prefixes with explicit cache breakpoints are eligible. AM's LM API requests do not carry these breakpoints and can miss the cache. |

## Why an upgrade alone may not fix it

Copilot Chat 0.67 (VS Code 1.139) defaulted this setting to `true`. Copilot 0.68 and later default it to `false`, but Copilot can override that default through experiments, and an existing user or workspace value can still enable explicit mode.

AM can inspect explicit settings and the default visible through VS Code's configuration API. It cannot reliably read Copilot's internal experiment assignment. An unset value with a visible default of `false` therefore does not prove that Copilot will use implicit mode.

The failure was reproduced with Marketplace AM 2.14.1, VS Code 1.142.0, Copilot 0.70.0, and `gpt-6-sol`. Five identical requests with the setting `true` all reported zero cache reads. With `false`, requests after warm-up reused 20,842 of 20,845 input tokens. This confirms the failure path, not that every zero-cache report has the same cause.

## Startup notification

When Copilot's setting is available, AM classifies its state from explicit User and Workspace values, with Workspace taking precedence:

| State                                   | Startup behavior                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit `false` (implicit mode)        | No notification. A Workspace-only `false` applies only to that workspace.                                                                                                |
| Explicit `true` (explicit mode)         | Show a one-time modal warning about the known cache-miss risk.                                                                                                           |
| Neither scope configured (unknown mode) | Show a one-time modal warning about the possible experiment risk, without claiming explicit mode has been detected. A visible default does not resolve this uncertainty. |

The native modal dialog offers **Use Implicit Cache Mode** and **Keep Current Settings**. AM records that the warning was shown only after the dialog returns, whether the user accepts, keeps the current settings, or dismisses it. Explicit and unknown modes share this record, so the startup warning does not repeat even if the mode later changes or a configuration write fails. If the dialog itself cannot be shown, AM does not suppress future warnings. The command below remains available.

Only **Use Implicit Cache Mode** changes configuration: it sets User settings to `false`, then removes the current Workspace's explicit value so that it inherits the User setting. Both changes are disclosed in the dialog before the same confirmation; the action never switches its write target from User to Workspace. Keeping the current settings or dismissing the dialog changes no configuration.

## Switch modes at any time

Run **Agent Maestro: Configure Copilot Prompt Cache** from the Command Palette. The picker offers:

- **false — Implicit (recommended for AM):** allow automatic prefix caching.
- **true — Explicit:** use Copilot's explicit cache breakpoints; AM's GPT requests can have zero cache hits.

The picker identifies the current User setting, Workspace override, and visible value. Selecting an item writes the chosen mode to User settings and removes any current Workspace override, including one added while the picker was open; cancelling makes no change. AM verifies the User value and that the current Workspace has no override before reporting success. If the User write fails, the Workspace override is left untouched. If the User write succeeds but override removal fails, AM explicitly reports the partial result instead of claiming the mode is effective.

**This is Copilot's shared setting, not an AM-only option.** User settings apply to other windows using the same VS Code Profile and User configuration. AM clears only the current Workspace's override; it does not scan, modify, or override settings in other workspaces, which can still take precedence. Native GPT chat switches cache mode too, and its cache hit rate, latency, cost, and tool-result serialization may change. AM's result does not establish whether native Chat benefits. Anthropic's cache controls are separate.

To configure implicit mode manually, set the following in User settings and check that workspace settings do not override it:

```json
"github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled": false
```

No reload is needed; new requests use the updated setting. Compare several consecutive requests with the same model and a stable long prefix in **Output → Agent Maestro**, using `cache_read / input` after warm-up. `cache_write: 0` is currently an AM placeholder for GPT Responses and does not diagnose whether caching works. Missing provider usage also falls back to zero cache reads, so persistent zeroes require checking the provider's usage metadata.
