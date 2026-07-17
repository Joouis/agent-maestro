# Changelog

## v2.11.1 - 2026.07.17

- Add `Configure Claude Desktop Settings` command to point Claude Desktop at the Agent Maestro proxy.

## v2.11.0 - 2026.07.15

- Add experimental commands that patch the currently loaded Copilot Chat bundle to append the OpenAI web search tool declaration for supported GPT-5 Codex requests, and restore backups created by that patch. Tested with `ChatGPT 26.707.72221`: `GPT-5.4` and `GPT-5.5` work; `GPT-5.6` does not yet forward the web search tool declaration to the server.
- Preserve Codex custom tool source input when proxying OpenAI Responses tool calls.
- Cancel stalled Anthropic and OpenAI language model requests after ten minutes or when clients disconnect.

## v2.10.0 - 2026.07.10

- Add support for OpenAI Responses API `additional_tools`, `custom`, and `namespace` tools, enabling GPT-5.6 and Codex tool calling through Agent Maestro. Custom tool calls now preserve raw string input, and named `tool_choice` requests are enforced.
- Remove the GitHub Copilot Chat header fixer command because current VS Code builds ship Copilot Chat as a built-in extension, making the old user-extension patch path obsolete.

## v2.9.7 - 2026.07.04

- Fix Anthropic tool-result images being rejected as a media-type mismatch when large JPEG/GIF/WebP bytes were relabeled as PNG. Top-level image parts still keep the VS Code resize workaround, while nested tool-result images now preserve their declared media type.
- Stop showing an MCP startup notification during extension activation when no Roo-compatible task manager is available.

## v2.9.6 - 2026.06.23

- Forward reasoning effort settings to Copilot for OpenAI and Anthropic proxy requests. OpenAI-backed models apply the setting today; Claude/Anthropic requests forward it but require upstream Copilot support to take effect.
- Fix images sent to Copilot vision models being rejected as a media-type mismatch (e.g. "specified image/jpeg, but the image appears to be image/png"). The VS Code Language Model API re-encodes images to PNG when both dimensions exceed 768px without updating their declared MIME type; Agent Maestro now relabels affected images so the type matches the bytes. Applies to the Anthropic, OpenAI Chat, OpenAI Responses, and Gemini routes.

## v2.9.5 - 2026.06.10

- Fix Claude Code 1M model routing to preserve requested model IDs instead of rewriting them to synthetic internal Copilot variants.
- Recommend `gemini-3.5-flash` instead of `gemini-2.5-pro` in `Configure Gemini CLI Settings`.
- Sort models within each family group newest-first in the configurator model picker, so the latest models (e.g. `claude-opus-4.8`) appear at the top.
- Remove the `agent-maestro.codex.contextWindowScaleFactor` setting. `Configure Codex Settings` command now writes `model_context_window` to Codex's `config.toml` directly from the selected model's reported `maxInputTokens`. To customize the window, edit `model_context_window` in `~/.codex/config.toml`.
- Remove the `agent-maestro.anthropic.tokenCountScaleFactor` setting. Fallback Anthropic token estimates and `/v1/messages/count_tokens` responses are now reported using VS Code's raw token count instead of a configurable 1.25× multiplier. To make Claude Code compact context earlier, use its `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` env vars — rerun `Configure Claude Code Settings` to have these written for you.

## v2.9.4 - 2026.06.03

- Use advertised max input tokens to mark 1M-capable Claude Code models, and avoid rewriting non-Claude 1M model IDs to Claude-specific internal variants.
- Configure Claude Code auto-compaction from the selected model's max input tokens, with a default 85 percent compaction threshold when the user has not set one. Rerun `Configure Claude Code Settings` to apply these settings.
- Pass Copilot's advertised max input tokens as the VS Code context size for proxied model requests.

## v2.9.3 - 2026.06.02

- Opt into Copilot's long-context configuration for Claude models with larger context windows so VS Code does not fall back to the default 200K prompt budget.
- Use Copilot usage metadata for Gemini-compatible responses, including cached prompt and reasoning token counts, while retaining token counting as a fallback.

## v2.9.2 - 2026.05.23

- Use Copilot usage metadata for OpenAI-compatible chat completions and responses when available, including cached input and reasoning token details.

## v2.9.1 - 2026.05.21

- Use Copilot usage metadata from VS Code language model responses to report Anthropic-compatible input, output, and prompt cache token counts, with the previous token estimation path retained for count_tokens and fallback usage. Also raise the minimum VS Code engine to `^1.120.0`.
- Set `CLAUDE_CODE_ATTRIBUTION_HEADER=0` in generated Claude Code `settings.json` to disable the `x-anthropic-billing-header` (CCH), which can break prompt caching on non-Anthropic LLM gateways.

## v2.9.0 - 2026.05.16

- Add Anthropic-compatible model listing and retrieval endpoints to support Claude Desktop 3P gateway compatibility, including model context limits and known capability metadata from VS Code language models.
- Use the IPv4 loopback address for generated Claude Code, Codex, and Gemini CLI proxy URLs to avoid localhost resolution issues.
- Report numeric zero cache-token usage fields across Anthropic, OpenAI, and Gemini-compatible routes and strip unsupported OpenAI prompt cache hints before forwarding model options.

## v2.8.7 - 2026.05.12

- Fix Anthropic `/v1/messages` length-truncated responses from VS Code/Copilot so partial content can be returned successfully with `stop_reason: "max_tokens"` instead of a 500 error.

## v2.8.6 - 2026.05.03

- Route Claude Code 1M context requests through its 1M model signal and remove automatic oversized-prompt upgrades. For exact 1M model selection, run `Configure Claude Code Settings` and choose the desired 1M model explicitly.
- Fix `/v1/messages` failing or hanging when Claude Code (or any client) sends Anthropic server-side tool definitions such as `web_search_20250305`, `computer_20250124`, `bash_20250124`, etc. The previous tool converter stuffed the entire tool object into `inputSchema`, producing invalid JSON Schema (`tools.0.custom.input_schema.type: Input should be 'object'`) and, when no upstream error surfaced, leaving the client waiting forever for a `tool_result` that VS Code's Language Model API cannot produce. These tools are now dropped with a logged warning so the model never sees them and the request proceeds normally. Fixes #163, addresses #150.
- Fix Anthropic `tool_result` image blocks by routing image content through `LanguageModelDataPart` instead of serialized JSON text, matching top-level user-message image handling.
- Fix multi-turn Gemini tool calls failing with `the number of function response parts is equal to the number of function call parts of the function call turn`. `langchain-google-genai` 4.x emits `functionResponse` parts with only `name` (no `id`), relying on Gemini's positional pairing rules; the previous strict id check dropped those parts entirely. The converter now walks all parts in document order, assigns a stable `callId` to every `functionCall`, and uses a per-name FIFO queue to recover the matching `callId` when a `functionResponse` arrives without one.
- Fix `/v1/chat/completions` failing with `Unexpected chat message content type llm 2` when the OpenAI client sends a `system` or `developer` message whose content is an array of text blocks (deepagents, langchain-openai, etc. do this when splitting long system prompts). The converter previously mapped each block to a bare `{ value: text }` object, which Copilot Chat's `_convertMessages` does not accept. Each block is now wrapped in `LanguageModelTextPart`, mirroring the user-role branch.

## v2.8.5 - 2026.03.28

- Change default `codex.contextWindowScaleFactor` from 1.3 to 1 to better align with model context limits.
- Auto-upgrade to 1M context variant when input exceeds model's context window

## v2.8.4 - 2026.03.13

- Add image (vision) support to Chat Completions route — convert base64 data URI `image_url` parts to `LanguageModelDataPart` instead of JSON-serializing them as text, fixing token limit errors for vision requests (#154)

## v2.8.3 - 2026.03.05

- Filter supported chat models to `copilot` vendor only and log a formatted table of all discovered models with proxy-eligibility status

## v2.8.2 - 2026.03.03

- Support Claude 1M context models by detecting `context-1m` in `anthropic-beta` header — users must select the 1M variant (e.g. `Opus (1M)`) via `/model` command in Claude Code, otherwise the client remains unaware of the extended context window
- Add `sequence_number` to all Responses API streaming events and align response envelope with upstream format
- Lower minimum `tokenCountScaleFactor` from `1` to `0.1`

## v2.8.1 - 2026.02.13

- Simplify Anthropic token calibration from complex linear regression to a single configurable scale factor (`agent-maestro.anthropic.tokenCountScaleFactor`, default `1.25`)
- Return structured response with "model_context_window_exceeded" stop reason when context window is exceeded, instead of passing through a misleading generic error.
- Fix tool conversion to handle any tool naming convention by detecting built-in tools via input_schema presence instead of hardcoded name matching.

## v2.8.0 - 2026.01.31

- Added OpenAI Responses API support (`POST /api/openai/v1/responses`) with streaming and function tools
- Updated OpenAI endpoints to use `/v1` prefix for API consistency (`/v1/chat/completions`, `/v1/responses`)
- Changed Codex default wire API from `chat` to `responses` ([Deprecating `chat/completions` support in Codex #7782](https://github.com/openai/codex/discussions/7782))
- Added `model_context_window` setting to Codex configuration with configurable scale factor via `agent-maestro.codex.contextWindowScaleFactor` (default: 1.3), applied as a multiplier to the model's `maxInputTokens` to compensate for local vs API token counting differences

## v2.7.0 - 2026.01.29

- Added optional API key authentication to secure LLM API endpoints (Anthropic, OpenAI, Gemini), with keys stored securely in VS Code secrets and protected by constant-time comparison.
- Normalize Gemini schema type fields from uppercase to lowercase for VSCode Language Model API compatibility, fixing issues with LangChain and Google's official SDKs.

## v2.6.1 - 2026.01.22

- Fix Gemini 400 Bad Request by handling unsupported tool schemas

## v2.6.0 - 2026.01.21

- Add fuzzy model matching using Jaccard similarity
  - Match model IDs with date suffixes to available models (e.g., `claude-opus-4-5-20251101` → `claude-opus-4.5`)
  - Warn when no Claude models found (VPN/network issue hint)
  - Add error hints for `model_not_supported` errors
  - Improve logging format (→ request, ← response, ✕ error)
- Add trivial model-specific token calibration for Opus models

## v2.5.3 - 2026.01.17

- Mitigate "unexpected `tool_use_id` found in `tool_result` blocks" 400 errors by calibrating Anthropic token counts with linear regression to trigger auto-compact before context window limit is exceeded
- Improve token counting for Gemini and OpenAI APIs by including full request payload (tools, config, system instructions)

## v2.5.2 - 2025.12.28

- Added comprehensive error diagnostics with detailed logging for Anthropic, Gemini, and OpenAI API routes
- Enhanced Codex configuration to incrementally update TOML files, preserving existing user settings while updating only Agent Maestro provider configuration.

## v2.5.1 - 2025.12.14

- Automatically complete Claude onboarding to skip login flow during setup

## v2.5.0 - 2025.11.30

- Add `/roo/settings` and `/roo/modes` API routes
- Log request payload and error context to diagnostic files for `/v1/messages` route with user data sanitized for privacy to help diagnose "unexpected `tool_use_id` found in `tool_result` blocks" issue

## v2.4.1 - 2025.11.19

- Gemini CLI configuration now detects `.env` files at workspace root and warns that project settings will take precedence over user settings
- Recommended model `gemini-2.5-pro` is now prioritized in the Gemini model selection UI
- Improved error handling in `streamGenerateContent` API, enabling the Gemini CLI to display more accurate and descriptive error messages

## v2.4.0 - 2025.11.16

- **Gemini CLI integration** with one-click setup command and **Gemini-compatible** API endpoints
  - `POST /api/gemini/v1beta/models/{model}:generateContent` - Generate content
  - `POST /api/gemini/v1beta/models/{model}:streamGenerateContent` - Streaming generation
  - `POST /api/gemini/v1beta/models/{model}:countTokens` - Token counting
- Skip schema validation for Anthropic and OpenAI routes

## v2.3.6 - 2025.11.03

- New **"Fix GitHub Copilot Chat - Enable Additional Models"** command to fix "Model is not supported for this request" error by removing header restrictions ([reference](https://github.com/cline/cline/issues/2186#issuecomment-2727010228))

## v2.3.5 - 2025.10.18

- Fixed issue where responses from the "Execute Roo Tasks" MCP tool were being truncated

## v2.3.4 - 2025.10.15

- Add automatic port monitoring to ensure Proxy and MCP server availability
- Improved Claude model handling to prioritize user-configured models over hardcoded defaults

## v2.3.3 - 2025.10.02

- **Seamlessly support Claude Code native extension** by self-check and extra config

## v2.3.2 - 2025.09.30

- Show warning when detecting Claude Code extension versions newer than `v1.0.127` (native v2), which ignore LLM Gateway settings and may limit Agent Maestro features.
- Updated README note to clarify compatibility:
  - Agent Maestro continues to work with the Claude Code CLI (terminal).
  - Supported on legacy extension versions prior to v2.

## v2.3.1 - 2025.09.28

- Add tool handling support for non-streaming `/v1/messages` API
- Add tool calls to output token counts for `/v1/messages` API
- Prompt user to reload VS Code window after updating or creating Codex configuration to ensure changes take effect

## v2.3.0 - 2025.09.25

- Add **OpenAI-compatible** `POST /chat/completions` endpoint
- New **"Configure Codex Settings" command** for one-click setup; `GPT-5-Codex` is now the recommended top model
- Updated scope of `agent-maestro.defaultRooIdentifier`, `agent-maestro.proxyServerPort`, and `agent-maestro.mcpServerPort` to support workspace-level config via VS Code `settings.json`
- Added support for configuring user settings in Claude Code
- Default Claude Code settings now set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- Anthropic System prompt is now treated as a user message instead of an assistant message

## v2.2.1 - 2025.09.08

- Add support for JPEG, GIF, and WebP images in Anthropic Messages API (works in VS Code Insiders, coming to stable release, see [#265553](https://github.com/microsoft/vscode/issues/265553))

## v2.2.0 - 2025.09.07

- Add PNG image support for Anthropic Messages API, enabling image-to-text capabilities
- Fix model selection bug that incorrectly used Claude-3.5 when GPT or other non-Claude models were selected
- Improve MCP server startup error handling and messaging

## v2.1.0 - 2025.08.24

- New endpoints for creating, updating, deleting, listing, and activating Roo Code configurations.
- Support for `AGENT_MAESTRO_PROXY_PORT` and `AGENT_MAESTRO_MCP_PORT` environment variables to override default server ports.
- Cache LM chat models to improve performance, especially in GitHub Codespaces environments.
- Proxy server now listens on wildcard address instead of loopback address for better connectivity.

## v2.0.2 - 2025.08.17

- Fix unsupported Claude models issues.
- Add extensive debug logging for Roo message events and Anthropic-compatible API request/response data. This detailed logging is available at the "Debug" level and can be enabled via the `Developer: Set Log Level...` command in VS Code (default level is "Info").
- Add validation for images payload of roo/cline task.
- Handle mcp server start failure gracefully when no Roo extension activated.

## v2.0.1 - 2025.08.05

### Breaking changes

- **Roo task SSE events renamed** to follow [RooCodeEventName](https://github.com/RooCodeInc/Roo-Code/blob/main/packages/types/src/events.ts) enum.
  - The most commonly used `message` event remains unchanged.
  - Removed events: `stream_closed`, `task_completed`, `task_aborted`, `tool_failed`, `task_created`, `error`, `task_resumed`.
- **OpenAPI path changed** from `/api/v1/openapi.json` to `/openapi.json`.

### New features

- **Anthropic-compatible endpoints** for GitHub Copilot API:
  - `POST /api/anthropic/v1/messages`
  - `POST /api/anthropic/v1/messages/count_tokens`
- **"Configure Claude Code Settings" command** for one-click setup, making Claude Code instantly usable
- `GET /api/v1/lm/tools` - lists all tools registered via `lm.registerTool()`.
- `GET /api/v1/lm/chatModels` - lists available VS Code Language Model API chat models.
- All Roo events now exposed in the Roo task/message SSE stream.

### Infrastructure

- Switched to Hono Framework for improved stability and performance.

## v1.3.1 - 2025.07.23

- Fix send message does not work for the inactive chat issue
- Enable response compression when content size is larger than 1KB

## v1.3.0 - 2025.07.10

- Enhanced OS data for `/info` API
- Support open VS Code workspaces and close all

## v1.2.0 - 2025.07.03

- Support `/fs/write` API
- New config to allow file access outside the current workspace

## v1.1.0 - 2025.07.03

- Make server ports configurable and code refactoring
- Fix missing init original Roo adapter

## v1.0.1 - 2025.07.02

- Enable parallel roo tasks execution feature by self-hosting MCP server
- New extension config to use Roo extension variants like Kilo Code
- Support install MCP server config to extension by command and API
- Add `/info` API for proxy server
- Fix new empty tab groups created when executing multiple roo tasks

## v0.4.0 - 2025.06.19

- Support cancel current Roo task and resume Roo task by ID
- Support get Roo task with id
- Fix 'message "number" is required' issue when requesting /roo/tasks

## v0.3.0 - 2025.06.17

- Support fetch Roo task history
- Support `newTab` argument for new Roo task creation

## v0.2.5 - 2025.06.17

- Fix logo missing issue and reduce package size by removing unnecessary files
- Do not show output panel at extension activation

## v0.2.4 - 2025.06.16

- Added file system read API for project file access
- Added configuration support when creating new Roo tasks
- Improved extension publishing and dependency management
- Added Server-Sent Events (SSE) documentation for Roo API
- Proxy server skips start if another one is already running, otherwise find an available port if default one has been used

## v0.1.0 - 2025.06.14

- Multi-agent support for RooCode and Cline extensions
- RESTful API server with OpenAPI documentation
- Interactive demo interface with real-time messaging
- Task management and streaming capabilities
- Extension auto-discovery and management
- Built-in message handling and connection stability
