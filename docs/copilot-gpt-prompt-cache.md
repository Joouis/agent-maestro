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

When Copilot's setting is available and no effective explicit `false` is configured, AM shows a one-time notification offering **Use Implicit Cache Mode**. For unset settings, it describes a possible experiment risk rather than claiming explicit mode is active. It does not change settings until the user clicks the button.

Closing the notification leaves settings untouched. AM records that the notice was shown; the command below remains available. Existing workspace overrides take precedence over user settings, so the one-click action updates the scope currently controlling the setting, or User settings when there is no explicit value.

## Switch modes at any time

Run **Agent Maestro: Configure Copilot Prompt Cache** from the Command Palette. The picker offers:

- **false — Implicit (recommended for AM):** allow automatic prefix caching.
- **true — Explicit:** use Copilot's explicit cache breakpoints; AM's GPT requests can have zero cache hits.

The picker identifies the current visible value and the settings scope it will update. Selecting an item is an explicit choice; cancelling makes no change. A successful update reports which scope was changed. If a write fails, AM reports the error instead of claiming the mode changed.

**This is Copilot's shared setting, not an AM-only option.** User settings can affect other VS Code windows; workspace settings also affect native Copilot Chat in that workspace. Native GPT chat switches cache mode too, and its cache hit rate, latency, cost, and tool-result serialization may change. AM's result does not establish whether native Chat benefits. Anthropic's cache controls are separate.

To configure implicit mode manually, set the following in User settings and check that workspace settings do not override it:

```json
"github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled": false
```

No reload is needed; new requests use the updated setting. Compare several consecutive requests with the same model and a stable long prefix in **Output → Agent Maestro**, using `cache_read / input` after warm-up. `cache_write: 0` is currently an AM placeholder for GPT Responses and does not diagnose whether caching works. Missing provider usage also falls back to zero cache reads, so persistent zeroes require checking the provider's usage metadata.
