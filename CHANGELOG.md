# Changelog

## v1.0.0 - 2025.07.01-beta.0

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
