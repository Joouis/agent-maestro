# Agent Maestro

<!-- [![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![License](https://img.shields.io/github/license/Joouis/agent-maestro)](./LICENSE) -->

Headless VS Code AI integrates best-in-class AI agents into any workflow, assisting, automating tasks, and generating solutions seamlessly. Now supporting Claude Code via Anthropic-compatible endpoints.

![Claude Code Support](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/claude-code-support.jpg)

![Agent Maestro Demo](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/agent-maestro-demo.gif)

## 🎉 What's New in v2.0.0

### **GitHub Copilot + Claude Code Integration**

- **Anthropic-Compatible Endpoints**: Leverage VS Code's built-in language model supported by GitHub Copilot through Claude-compatible APIs without additional subscription
- **One-Click Claude Code Setup**: Automated configuration command for instant Claude Code integration

### **Enhanced Performance & Stability**

- **Hono Framework Migration**: Improved performance, better stability, enhanced type safety
- **VS Code Language Model API**: Direct access to VS Code's native LM ecosystem
- **Streamlined Architecture**: Smaller memory footprint and faster response times

## Why Agent Maestro

AI Agents represent a transformative shift—from simple LLM calls to autonomous collaborators that function as employees, partners, or entire development teams at your command. While open-source agent frameworks offer flexibility, they often require significant setup and configuration.

VS Code extensions like GitHub Copilot Chat, Cline, and Roo Code have collectively surpassed tens of millions of downloads, offering battle‑tested, out‑of‑the‑box agent experiences. Agent Maestro taps into this maturity as among the first headless bridges to VS Code’s best‑in‑class AI agents: no custom framework setup, no GUI dependencies. Leverage VS Code’s unified APIs and rich model catalog (including free tiers) to assist tasks, automate workflows, and generate solutions across any environment—from CI pipelines and scripts to your terminal—effortlessly.

## Key Features

- **Anthropic Compatibility**: Use GitHub Copilot with Claude Code through Anthropic-compatible endpoints
- **One-Click Claude Code Setup**: Automated configuration command for instant Claude Code integration
- **Parallel Task Execution**: Execute up to 20 concurrent AI coding tasks through built-in MCP server integration
- **Unified API Gateway**: Single RESTful interface controlling multiple AI agents through standardized endpoints
- **Multi-Agent Support**: Currently supports RooCode (and its variants like Kilo Code) and Cline extensions with plans for GitHub Copilot
- **Real-time Event Streaming**: Server-Sent Events (SSE) for live task monitoring and message streaming
- **Task Management**: Comprehensive lifecycle management with creation, execution, monitoring, and completion tracking
- **OpenAPI Documentation**: Auto-generated API documentation accessible via `/openapi.json`
- **Extension Auto-Discovery**: Automatic detection and activation of installed AI coding extensions

**Note on Agent Support**: While Cline integration is included, RooCode offers the most comprehensive integration capabilities and is recommended for production use. GitHub Copilot integration via Anthropic endpoints provides the best balance of features and reliability.

## Quick Start

### Prerequisites

Agent Maestro assumes you already installed [Roo Code](https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline) or its variants for the web proxy scenario, or [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) for personal development routines.

### Installation

Install the [Agent Maestro extension](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro) from the VS Code Marketplace. Once activated, Agent Maestro automatically starts its API server on startup.

### One-Click Setup for Claude Code

Configure Claude Code to use VS Code's language models with a single command `Agent Maestro: Configure Claude Code Settings` via Command Palette.

This automatically creates `.claude/settings.json` with Agent Maestro endpoint and fills in available LLM models from VS Code.

**That's it!** You can now use Claude Code with VS Code's built-in language models.

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

   **New Configuration Commands:**

   - `Agent Maestro: Configure Claude Code Settings` - One-click Claude Code setup

3. **Development Resources**:
   - **API Documentation**: Complete reference in [`docs/roo-code/`](docs/roo-code/README.md)
   - **Type Definitions**: [`@roo-code/types`](https://www.npmjs.com/package/@roo-code/types) package
   - **Examples**: Reference implementation in `examples/demo-site` (testing purposes)

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

## API Overview

Agent Maestro v2.0.0 provides multiple API interfaces for different integration needs.

> 💡 **Always refer to [`/openapi.json`](http://localhost:23333/openapi.json) for the latest API documentation.**

### Base URLs

- **REST API**: `http://localhost:23333/api/v1`
- **Anthropic API**: `http://localhost:23333/api/anthropic/v1`
- **MCP Server**: `http://localhost:23334`

### Anthropic-Compatible Endpoints

Perfect for GitHub Copilot and Claude Code integration:

- **`POST /api/anthropic/v1/messages`** - Anthropic Claude API compatibility using VS Code's Language Model API
- **`POST /api/anthropic/v1/messages/count_tokens`** - Token counting for Anthropic-compatible messages

### RooCode Agent Routes

Full-featured agent integration with real-time streaming:

- **`POST /api/v1/roo/task`** - Create new RooCode task with SSE streaming
- **`POST /api/v1/roo/task/{taskId}/message`** - Send message to existing task with SSE streaming
- **`POST /api/v1/roo/task/{taskId}/action`** - Perform actions (pressPrimaryButton, pressSecondaryButton, cancel, resume)

### VS Code Language Model API

Direct access to VS Code's language model ecosystem:

- **`GET /api/v1/lm/tools`** - Lists all tools registered via [`lm.registerTool()`](https://code.visualstudio.com/api/extension-guides/language-model)
- **`GET /api/v1/lm/chatModels`** - Lists available VS Code Language Model API chat models

### Cline Agent Routes

Basic integration support:

- **`POST /api/v1/cline/task`** - Create new Cline task (basic support)

### Documentation Routes

- **`GET /openapi.json`** - Complete OpenAPI v3 specification

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

- **VS Code LM API**: OpenAPI compatible API based on GitHub Copilot and VS Code LM API.
- **Production Deployment**: Code-server compatibility for containerization and deployment

**Contributions Welcome**: We encourage community contributions to help expand Agent Maestro's capabilities and support for additional AI coding agents. We recommend using AI coding agents themselves to accelerate your development workflow when contributing to this project.

## License

This project is licensed under the terms specified in the [LICENSE](./LICENSE) file.

---

<div align="center">

**⭐ Star this project if you find it useful!**

Built with ❤️ by AI agents for AI agents

[🐛 Report Bug](https://github.com/Joouis/agent-maestro/issues) • [✨ Request Feature](https://github.com/Joouis/agent-maestro/issues) • [💬 Discussions](https://github.com/Joouis/agent-maestro/discussions)

</div>
