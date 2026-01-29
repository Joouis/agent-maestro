# Changelog

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

## v0.3.0 - 2025-06-17

- Support fetch Roo task history
- Support `newTab` argument for new Roo task creation

## v0.2.5 - 2025-06-17

- Fix logo missing issue and reduce package size by removing unnecessary files
- Do not show output panel at extension activation

## v0.2.4 - 2025-06-16

### Features

- Added file system read API for project file access
- Added configuration support when creating new Roo tasks
- Improved extension publishing and dependency management
- Added Server-Sent Events (SSE) documentation for Roo API
- Proxy server skips start if another one is already running, otherwise find an available port if default one has been used

## v0.1.0 - 2025-06-14

### Features

- Multi-agent support for RooCode and Cline extensions
- RESTful API server with OpenAPI documentation
- Interactive demo interface with real-time messaging
- Task management and streaming capabilities
- Extension auto-discovery and management
- Built-in message handling and connection stability
