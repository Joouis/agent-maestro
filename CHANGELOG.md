# Changelog

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
