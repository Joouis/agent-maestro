# Experimental GPT-5+ Web Search Patch

Agent Maestro can locally patch the currently running VS Code Copilot bundle so OpenAI Responses requests can carry hosted web search tool declarations through `vscode.lm.sendRequest()` for GPT major version 5 or newer models.

This is intentionally experimental. Agent Maestro does not implement web search itself, does not call a local `web_search` function tool, and does not guarantee that a Copilot backend model will accept or use the hosted web search tool. It only preserves and forwards the web search tool declaration already present in the OpenAI Responses request, following OpenAI's hosted web search tool shape:

https://developers.openai.com/api/docs/guides/tools-web-search

## Why a Patch Is Needed

The VS Code Language Model API accepts function-style tools through request options. Copilot's internal OpenAI Responses route also builds a final `tools` array for the server request, but unsupported hosted tool declarations such as `web_search` are not exposed as normal VS Code function tools.

Agent Maestro therefore uses a marker function tool as a transport envelope:

- Tool name: `__agent_maestro_web_search__`
- Parameter name: `x-agent-maestro-web-search-tool`
- Parameter value: the original hosted web search tool from the incoming Responses request

The patched Copilot bundle recognizes that marker, removes the marker function tool before the final server request, extracts the hosted `web_search*` declaration, and inserts that hosted tool into Copilot's final OpenAI Responses `tools` array.

## Enable Flow

Run `Agent Maestro: Enable Experimental GPT-5+ Web Search` from the Command Palette.

The command:

- Finds the currently loaded GitHub Copilot Chat bundle first, including Extension Development Host bundles.
- Falls back to the current VS Code app bundle path when the loaded extension path is unavailable.
- Creates a timestamped backup beside the target bundle before writing changes.
- Applies the patch only when a supported Copilot Responses injection point is found.
- Leaves an already patched bundle unchanged, so running the command multiple times does not duplicate the injected code.
- Enables `agent-maestro.experimentalGpt5PlusWebSearchEnabled`.
- Reloads VS Code after a successful patch.

## Request Flow

For `/v1/responses` requests:

1. The client sends a Responses request with a hosted web search tool such as `web_search` or `web_search_preview`.
2. Agent Maestro reads `agent-maestro.experimentalGpt5PlusWebSearchEnabled`.
3. Agent Maestro only activates the marker path when the resolved model or Copilot family is GPT major version 5 or newer.
4. Agent Maestro adds the internal marker function tool to the VS Code LM request options.
5. The patched Copilot bundle removes the marker function tool and inserts the original hosted web search declaration into the final server-side `tools` array.
6. The Copilot backend decides whether that model can use hosted web search and whether the current request needs it.

Because hosted web search is handled by the model backend, a successful search may not produce a local VS Code tool call.

### Codex Standalone Search

Recent Codex models that use Responses Lite do not attach hosted tools to `/v1/responses`. When Codex enables its `standalone_web_search` feature for an opted-in custom provider, it instead calls `POST /v1/alpha/search`. Agent Maestro exposes that endpoint and adapts the Codex search command to the same patched Copilot hosted web-search path.

The endpoint requires the experimental patch setting and a GPT-5+ Copilot model. It returns the Copilot search text in the Codex `output` field, including source URLs supplied by the backend. Agent Maestro does not synthesize Codex structured `results` metadata. Custom Codex providers must set `supports_standalone_web_search = true` and enable Codex's `standalone_web_search` feature before Codex will call this endpoint.

## Restore Flow

Run `Agent Maestro: Restore Experimental GPT-5+ Web Search Backup` from the Command Palette.

The command:

- Lists backups created for the currently resolved Copilot bundle.
- Replaces the current bundle with the selected backup.
- Sets `agent-maestro.experimentalGpt5PlusWebSearchEnabled` to `false`.
- Reloads VS Code.

VS Code or Copilot updates can overwrite the patched bundle. If that happens, run the enable command again only after confirming the feature is still needed.

## Extension Development Host Notes

When Agent Maestro is running in an Extension Development Host, the active Copilot Chat bundle may come from a local development checkout rather than `/Applications/Visual Studio Code*.app`. The enable command intentionally patches the loaded bundle first so it affects the VS Code window that is actually sending requests.

If that development bundle is rebuilt or overwritten after reload, the patch can disappear. Re-run the enable command after the rebuild/reload if logs show the marker is no longer being injected.

## Troubleshooting

- Check Agent Maestro output for `Experimental GPT-5+ web search: ... injected=true`.
- If the log says `injected=false`, verify the setting is enabled, the request includes a `web_search*` tool, and the selected model resolves to GPT major version 5 or newer.
- If the model says it has no local `web_search` tool, that is not definitive. Hosted web search is inserted into the server-side Responses tool list, not exposed as a local function tool.
- On Windows, a system VS Code install under `C:\Program Files` usually requires running VS Code as Administrator before the patch command can write the bundle and create a backup. The VS Code User Installer avoids this by installing under a user-writable location.
- If the backend returns a 400 error, the hosted tool shape or selected model variant may not be accepted by that Copilot backend.
- If a reload or rebuild happened after enabling, run the enable command again because the bundle may have been regenerated.
