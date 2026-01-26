# Agent Maestro

<!-- [![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![License](https://img.shields.io/github/license/Joouis/agent-maestro)](./LICENSE) -->

Turn VS Code into your compliant AI playground! With Agent Maestro, spin up Cline or Roo on demand and plug Claude Code, Codex, or Gemini CLI straight in through an OpenAI/Anthropic/Gemini-compatible API.

![Claude Code Support](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/configure-claude-code-demo.gif)

![Agent Maestro Demo](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/agent-maestro-demo.gif)

## Key Features

Turn VS Code into your compliant AI playground with powerful API compatibility and one-click setup:

- **Universal API Compatibility**: Anthropic (`/messages`), OpenAI (`/chat/completions`), and Gemini compatible endpoints - use Claude Code, Codex, Gemini CLI or any LLM client seamlessly
- **One-Click Setup**: Automated configuration commands for instant Claude Code, Codex, and Gemini CLI integration
- **Headless AI Agent Control**: Create and manage tasks through REST APIs for Roo Code and Cline extensions
  - **Comprehensive APIs**: Complete task lifecycle management with OpenAPI documentation at `/openapi.json`
  - **Parallel Execution**: Run up to 20 concurrent RooCode (and its variants like Kilo Code) tasks with built-in MCP server integration
  - **Real-time Streaming**: Server-Sent Events (SSE) for live task monitoring and message updates
  - **Flexible Configuration**: Workspace-level settings, environment variables, and extension auto-discovery

## Quick Start

### Prerequisites

Agent Maestro assumes you already installed one of the supported AI coding extensions:

- [Roo Code](https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline) or its variants for comprehensive API control
- [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) for personal development routines
- [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) for personal development routines
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) for personal development routines

### Installation

Install the [Agent Maestro extension](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro) from the VS Code Marketplace. Once activated, Agent Maestro automatically starts its API server on startup.

### One-Click Setup for Claude Code

Configure Claude Code to use VS Code's language models with a single command `Agent Maestro: Configure Claude Code Settings` via Command Palette.

This automatically creates or updates `.claude/settings.json` with Agent Maestro endpoint and fills in available LLM models from VS Code.

**That's it!** You can now use Claude Code with VS Code's built-in language models.

### One-Click Setup for Codex

Configure Codex to use VS Code's language models with a single command `Agent Maestro: Configure Codex Settings` via Command Palette.

This automatically creates or updates `~/.codex/config.toml` with Agent Maestro endpoint and sets up `GPT-5-Codex` as the recommended model.

### One-Click Setup for Gemini CLI

Configure Gemini CLI to use VS Code's language models with a single command `Agent Maestro: Configure Gemini CLI Settings` via Command Palette.

You can choose between:

- **User Settings** (`~/.env`): Personal global settings for all projects
- **Project Settings** (`.env` in workspace): Team-shared project settings in source control

This automatically creates or updates the `.env` file with:

- `GOOGLE_GEMINI_BASE_URL`: Agent Maestro Gemini endpoint
- `GEMINI_API_KEY`: Default authentication token (preserved if already set)
- `GEMINI_MODEL`: Your selected model from available VS Code language models
- `GEMINI_TELEMETRY_ENABLED`: Disable telemetry by default

Additionally, it creates or updates `settings.json` in the same folder to skip the authentication method selection on first launch:

```json
{
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  }
}
```

### GitHub Copilot Chat Model Enhancement

Enable additional models in GitHub Copilot Chat with the `Agent Maestro: Fix GitHub Copilot Chat - Model is not supported error` command. ([ref](https://github.com/cline/cline/issues/2186#issuecomment-2727010228))

This feature:

- Automatically locates your GitHub Copilot Chat extension
- Creates a timestamped backup before making changes
- Removes the `x-onbehalf-extension-id` header restriction
- Verifies the fix was applied successfully
- Prompts you to reload VS Code for changes to take effect

**Note**: This modification may be overwritten when the Copilot Chat extension updates. Simply run the command again after updates if needed.

### Usage

1. **Explore API Capabilities**: Access the complete OpenAPI specification at [`http://localhost:23333/openapi.json`](http://localhost:23333/openapi.json).

2. **VS Code Commands**: Access functionality through the Command Palette:

   **Server Management:**

   - `Agent Maestro: Start API Server` - Start the proxy API server
   - `Agent Maestro: Stop API Server` - Stop the proxy API server
   - `Agent Maestro: Restart API Server` - Restart the proxy API server
   - `Agent Maestro: Get API Server Status` - Check current server status

   **MCP Server Management:**

   - `Agent Maestro: Start MCP Server` - Start the Model Context Protocol server
   - `Agent Maestro: Stop MCP Server` - Stop the MCP server
   - `Agent Maestro: Get MCP Server Status` - Check current MCP server status
   - `Agent Maestro: Install MCP Configuration` - Install MCP configuration for supported extensions

   **Extension Management:**

   - `Agent Maestro: Get Extensions Status` - Check the status of supported AI extensions

   **Configuration Commands:**

   - `Agent Maestro: Configure Claude Code Settings` - One-click Claude Code setup
   - `Agent Maestro: Configure Codex Settings` - One-click Codex setup
   - `Agent Maestro: Configure Gemini CLI Settings` - One-click Gemini CLI setup
   - `Agent Maestro: Fix GitHub Copilot Chat - Model is not supported error` - Remove header restriction to enable additional models
   - `Agent Maestro: Set LLM API Key` - Configure authentication for LLM API endpoints

3. **Development Resources**:
   - **API Documentation**: Complete reference in [`docs/roo-code/`](docs/roo-code/README.md)
   - **Type Definitions**: [`@roo-code/types`](https://www.npmjs.com/package/@roo-code/types) package
   - **Examples**: Reference implementation in `examples/demo-site` (testing purposes)

## LLM API Authentication

Agent Maestro supports optional API key authentication to secure access to the LLM API endpoints (Anthropic, OpenAI, and Gemini). When enabled, all requests to these endpoints must include a valid API key.

### Setting Up Authentication

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run `Agent Maestro: Set LLM API Key`
3. Enter your desired API key (or leave empty to disable authentication)

The API key is stored securely using VS Code's built-in secrets storage and persists across sessions.

### Authenticating Requests

Once authentication is enabled, include your API key in requests using the standard header format for each provider:

**Anthropic API** (`/api/anthropic/*`):

```bash
curl -H "x-api-key: YOUR_LLM_API_KEY" \
  http://localhost:23333/api/anthropic/v1/messages
```

**OpenAI API** (`/api/openai/*`):

```bash
curl -H "Authorization: Bearer YOUR_LLM_API_KEY" \
  http://localhost:23333/api/openai/chat/completions
```

**Gemini API** (`/api/gemini/*`):

```bash
curl -H "x-goog-api-key: YOUR_LLM_API_KEY" \
  http://localhost:23333/api/gemini/v1beta/models/gemini-3-pro:generateContent
```

### Security Notes

- Authentication is **disabled by default** for ease of local development
- When authentication is disabled, the proxy accepts all requests without validation
- API keys are compared using constant-time comparison to prevent timing attacks
- Failed authentication attempts are logged for security monitoring

## Configuration

### Environment Variables

You can customize Agent Maestro's server ports using environment variables:

| Variable                   | Description       | Default |
| -------------------------- | ----------------- | ------- |
| `AGENT_MAESTRO_PROXY_PORT` | Proxy server port | 23333   |
| `AGENT_MAESTRO_MCP_PORT`   | MCP server port   | 23334   |

**Usage:**

```bash
# Set custom ports
export AGENT_MAESTRO_PROXY_PORT=8080
export AGENT_MAESTRO_MCP_PORT=8081

# Launch VS Code
code .
```

> **Note:** Environment variables take precedence over extension settings.

### Workspace-Level Configuration

You can configure Agent Maestro settings per workspace by adding them to your project's `.vscode/settings.json` file:

```json
{
  "agent-maestro.defaultRooIdentifier": "rooveterinaryinc.roo-cline",
  "agent-maestro.proxyServerPort": 23333,
  "agent-maestro.mcpServerPort": 23334
}
```

**Available Settings:**

| Setting                              | Description                  | Default                        |
| ------------------------------------ | ---------------------------- | ------------------------------ |
| `agent-maestro.defaultRooIdentifier` | Default Roo extension to use | `"rooveterinaryinc.roo-cline"` |
| `agent-maestro.proxyServerPort`      | Proxy server port            | `23333`                        |
| `agent-maestro.mcpServerPort`        | MCP server port              | `23334`                        |

This allows different projects to use different configurations without affecting your global VS Code settings.

## API Overview

> 💡 **Always refer to [`/openapi.json`](http://localhost:23333/openapi.json) for the latest API documentation.**

### Base URLs

- **REST API**: `http://localhost:23333/api/v1`
- **Anthropic API**: `http://localhost:23333/api/anthropic`
- **OpenAI API**: `http://localhost:23333/api/openai`
- **Gemini API**: `http://localhost:23333/api/gemini`
- **MCP Server**: `http://localhost:23334`

### Anthropic-Compatible Endpoints

Perfect for GitHub Copilot and Claude Code integration:

- **`POST /api/anthropic/v1/messages`** - Anthropic Claude API compatibility using VS Code's Language Model API
- **`POST /api/anthropic/v1/messages/count_tokens`** - Token counting for Anthropic-compatible messages

### OpenAI-Compatible Endpoints

Perfect for Codex and OpenAI model integration:

- **`POST /api/openai/chat/completions`** - OpenAI Chat Completions API compatibility using VS Code's Language Model API

### Gemini-Compatible Endpoints

Perfect for Gemini CLI integration:

- **`POST /api/gemini/v1beta/models/{model}:generateContent`** - Google Gemini API compatibility using VS Code's Language Model API
- **`POST /api/gemini/v1beta/models/{model}:streamGenerateContent`** - Streaming support for Gemini API
- **`POST /api/gemini/v1beta/models/{model}:countTokens`** - Token counting for Gemini-compatible messages

### RooCode Agent Routes

Full-featured agent integration with real-time streaming:

- **`POST /api/v1/roo/task`** - Create new RooCode task with SSE streaming
- **`POST /api/v1/roo/task/{taskId}/message`** - Send message to existing task with SSE streaming
- **`POST /api/v1/roo/task/{taskId}/action`** - Perform actions (pressPrimaryButton, pressSecondaryButton, cancel, resume)
- **`GET /api/v1/roo/settings`** - Get current RooCode settings
- **`GET /api/v1/roo/modes`** - Get available RooCode modes

### VS Code Language Model API

Direct access to VS Code's language model ecosystem:

- **`GET /api/v1/lm/tools`** - Lists all tools registered via [`lm.registerTool()`](https://code.visualstudio.com/api/extension-guides/language-model)
- **`GET /api/v1/lm/chatModels`** - Lists available VS Code Language Model API chat models

### Cline Agent Routes

Basic integration support:

- **`POST /api/v1/cline/task`** - Create new Cline task (basic support)

### Documentation Routes

- **`GET /openapi.json`** - Complete OpenAPI v3 specification

## Error Diagnostics

Agent Maestro automatically logs detailed error diagnostics when API requests fail. Each extension launch creates a timestamped log file in your workspace root: `{YYYY}-{MM}-{DD}_{HH}-{MM}-{SS}-{mmm}-debug.log`. All errors during that session are appended to the same file.

**What's logged**: Request payload, transformed VSCode LM messages, error details, extension metadata, model ID, endpoint, and timestamp.

**Supported endpoints**:

- `/api/anthropic/v1/messages` (content sanitized)
- `/api/openai/chat/completions` (TODO: sanitization)
- `/api/gemini/v1beta/models/{model}:generateContent|streamGenerateContent` (TODO: sanitization)

**Privacy protection**:

- **Anthropic only**: User content is automatically redacted (text, images, documents, tool I/O, search results → `[REDACTED]`)
- **OpenAI/Gemini**: Not yet sanitized - **review carefully before sharing logs**

Error responses include the log file path for easy troubleshooting:

```json
{
  "error": {
    "message": "...",
    "log_file": "/path/to/workspace/2025-12-28_14-30-45-123-debug.log"
  }
}
```

**Tip**: Add `*-debug.log` to `.gitignore` to prevent committing diagnostic files.

## Migration from v1.x

⚠️ **Important changes when upgrading from v1.x:**

1. **Roo Task SSE Events Renamed**

   - Events now follow [`RooCodeEventName`](https://www.npmjs.com/package/@roo-code/types) enum
   - The `message` event remains unchanged (most commonly used)
   - **Removed events**: `stream_closed`, `task_completed`, `task_aborted`, `tool_failed`, `task_created`, `error`, `task_resumed`

2. **OpenAPI Path Change**
   - **Old**: `/api/v1/openapi.json`
   - **New**: `/openapi.json`

## Roadmap

Our development roadmap includes several exciting enhancements:

- **Production Deployment**: Code-server compatibility for containerization and deployment
- **Headless AI Agent Control**: Complete REST API integration for Claude Code and Codex extensions with task lifecycle management
- **Task Scheduler**: Cron-like scheduling system for automated AI agent tasks and workflows

**Contributions Welcome**: We encourage community contributions to help expand Agent Maestro's capabilities and support for additional AI coding agents. We recommend using AI coding agents themselves to accelerate your development workflow when contributing to this project.

## License

This project is licensed under the terms specified in the [LICENSE](./LICENSE) file.

---

<div align="center">

**⭐ Star this project if you find it useful!**

Built with ❤️ by AI agents for AI agents

[🐛 Report Bug](https://github.com/Joouis/agent-maestro/issues) • [✨ Request Feature](https://github.com/Joouis/agent-maestro/issues)

</div>
