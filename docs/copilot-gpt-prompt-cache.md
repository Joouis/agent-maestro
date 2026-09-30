# Copilot explicit prompt-cache mode and GPT cache misses

GPT requests that Agent Maestro (AM) proxies to Copilot can report `cached_tokens: 0` on every turn, even when consecutive requests share a long identical prefix. This page explains the cause and the fix.

## Symptom

- Affects GPT-5.6 and later and the GPT-6 family (for example `gpt-6-astra`) through the OpenAI Responses route, such as Codex.
- The AM Output channel shows `cache_read: 0` on every `/v1/responses` request.
- Observed with VS Code 1.139, which bundles Copilot Chat 0.67.

## Cause

For these models, Copilot's Responses request includes a cache mode, selected by the Copilot setting `github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled`:

| Setting                       | Mode sent upstream                           | Behavior                                                |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| `true` (Copilot 0.67 default) | `prompt_cache_options: { mode: "explicit" }` | Only prefixes marked with cache breakpoints are cached. |
| `false`                       | `prompt_cache_options: { mode: "implicit" }` | Matching prefixes are cached automatically.             |

Copilot's own chat inserts cache breakpoints into its prompts. Requests made through the VS Code Language Model API, which is how AM calls Copilot, carry no breakpoints. In explicit mode those requests therefore have nothing to cache and never hit.

Copilot Chat 0.68 (bundled with VS Code 1.140) defaults the setting to `false`, so it is not affected.

## Fix

Upgrade to VS Code 1.140 or later, which bundles Copilot Chat 0.68.

If you cannot upgrade, set the Copilot setting to `false` in user settings:

```json
"github.copilot.chat.responsesApi.promptCacheBreakpoint.enabled": false
```

No reload is needed; new requests use implicit mode. After the first request warms the cache, requests that repeat a prefix should report non-zero `cached_tokens`. If you previously set it to `true` explicitly, remove that value after upgrading.

With Copilot Chat 0.67, AM offers to apply this setting on startup when it has never been configured. It leaves an explicit `true` or `false` untouched, and does not prompt on other Copilot versions.

Anthropic-route requests use Anthropic cache controls and are unaffected.
