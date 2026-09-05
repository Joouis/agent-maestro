# Agent Maestro

Use Claude Code, Claude Desktop, Codex, and Gemini CLI with GitHub Copilot models through a local VS Code proxy. Agent Maestro also exposes REST and MCP interfaces for Roo Code task orchestration, plus basic Cline task creation.

![Claude Code setup](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/configure-claude-code-demo.gif)

## Features

- Anthropic Messages, OpenAI Chat Completions/Responses, and Gemini-compatible generation endpoints.
- Setup commands for four clients, model discovery, and configurable fallback models.
- Exa-backed web search for Anthropic, Responses, and experimental Codex standalone search.
- Roo Code task management with SSE updates and an MCP tool for up to 20 concurrent tasks.

This README and the [documentation index](docs/README.md) describe this checkout. Features in pending `.changeset/` entries may not yet be available in the installed Marketplace release; check the [changelog](CHANGELOG.md) for released versions.

## Quick Start

### Prerequisites

- VS Code **1.120.0 or newer**, with GitHub Copilot signed in and eligible models available. The LLM proxy currently selects models from the `copilot` vendor.
- Install the client you want to use: Claude Code, Claude Desktop, Codex, or Gemini CLI. Installing a client alone does not provide proxy models.
- Install Roo Code or a compatible variant such as Kilo Code only if you need task orchestration. Cline is optional and currently supports task creation only.

For source development, use Node.js 22 or newer and the pnpm version specified in [package.json](package.json).

### Install and Start

Install [Agent Maestro from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro) or [Open VSX](https://open-vsx.org/extension/Joouis/agent-maestro).

The API server starts when the extension activates. Its default port is `23333`; the MCP server uses `23334` when the configured default Roo extension can provide a task manager. If only Kilo Code is installed, set `agent-maestro.defaultRooIdentifier` to `kilocode.kilo-code` and reload VS Code before starting MCP. HTTP requests can also select an installed variant explicitly with `extensionId`. Use **Agent Maestro: Get API Server Status** to check the active port and the **Agent Maestro** Output channel to inspect startup or model-discovery errors.

### Configure a Client

Open the Command Palette and run the relevant command:

| Client         | Command                                              | Configuration written                                                                             |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude Code    | **Agent Maestro: Configure Claude Code Settings**    | Choose `~/.claude/settings.json` or `<workspace>/.claude/settings.json`                           |
| Claude Desktop | **Agent Maestro: Configure Claude Desktop Settings** | Platform-specific `Claude-3p/configLibrary` gateway configuration                                 |
| Codex          | **Agent Maestro: Configure Codex Settings**          | `~/.codex/config.toml`                                                                            |
| Gemini CLI     | **Agent Maestro: Configure Gemini CLI Settings**     | Choose `~/.gemini/.env` or `<workspace>/.gemini/.env`, plus `settings.json` in the same directory |

Claude Code, Codex, and Gemini setup lets you choose an available model. Fully quit and reopen Claude Desktop after configuring it. Reload or restart the other client after updating its configuration.

- **Claude Code:** The command sets the selected model and compaction window. For models advertising a 1M prompt budget, it adds the client-side `[1m]` marker. See [context-window handling](docs/claude-code-context-window.md).
- **Codex:** The command sets the Responses provider, model context window, and experimental standalone-search capability. An explicit `web_search = "disabled"` setting is preserved. See [search compatibility](docs/llm-compatibility.md#web-search).
- **Gemini CLI:** The `.env` file contains `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, and `GEMINI_TELEMETRY_ENABLED=false`. Existing API keys are preserved. The configurator warns about a workspace-root `.env` that can override user settings; check that file if the client still uses an old endpoint. The adjacent `.gemini/settings.json` sets `security.auth.selectedType` to `gemini-api-key`.

Generated placeholder client keys do not enable server authentication. If you set an LLM API key in Agent Maestro, configure the same key in the client.

For Claude Code with AM authentication enabled, set `ANTHROPIC_API_KEY` in the chosen settings file's `env` section and remove `ANTHROPIC_AUTH_TOKEN` there and from the launching environment. AM requires `x-api-key`; the configurator's `ANTHROPIC_AUTH_TOKEN` sends a bearer header instead. Keep `ANTHROPIC_BASE_URL` pointing to AM. Rerunning the configurator can reintroduce the token setting, so recheck these fields afterward. See Claude Code's [gateway authentication guidance](https://code.claude.com/docs/en/llm-gateway-rollout).

### Model Selection

Run **Agent Maestro: Select Fallback Model** to choose a model for requests whose model ID cannot be matched. Exact and fuzzy matches take priority. Selecting `auto` leaves automatic model selection in effect; unavailable models can fall back to another available Copilot model.

`GET /api/v1/lm/chatModels` lists models discovered by VS Code, including vendors that may not be proxy-eligible. The Output channel distinguishes eligible Copilot models.

## Configuration

Use VS Code settings for the following options. Port and default-Roo settings can be set per workspace; the other settings have application scope.

| Setting                                     | Default                      | Purpose                                             |
| ------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| `agent-maestro.proxyServerPort`             | `23333`                      | Proxy HTTP port                                     |
| `agent-maestro.mcpServerPort`               | `23334`                      | MCP port                                            |
| `agent-maestro.defaultRooIdentifier`        | `rooveterinaryinc.roo-cline` | Default Roo-compatible extension                    |
| `agent-maestro.rooVariantIdentifiers`       | `["kilocode.kilo-code"]`     | Additional Roo variants to discover                 |
| `agent-maestro.fallbackModelId`             | `""`                         | Fallback model; configure through the command above |
| `agent-maestro.allowOutsideWorkspaceAccess` | `false`                      | Permit filesystem access outside the workspace      |

`AGENT_MAESTRO_PROXY_PORT` and `AGENT_MAESTRO_MCP_PORT` environment variables override the corresponding settings. Restart the extension host after changing ports or extension identifiers.

**Install MCP Configuration** currently writes `http://localhost:23334/mcp` regardless of the configured port. If you use a custom MCP port, update that URL in the generated client configuration manually after installation.

## Access and Authentication

**Agent Maestro: Set LLM API Key** stores an optional key in VS Code SecretStorage. An empty value disables authentication. When enabled, clients use:

| Route prefix       | Header                        |
| ------------------ | ----------------------------- |
| `/api/anthropic/*` | `x-api-key: <key>`            |
| `/api/openai/*`    | `Authorization: Bearer <key>` |
| `/api/gemini/*`    | `x-goog-api-key: <key>`       |

See [complete request examples](docs/llm-compatibility.md#request-examples).

The HTTP server listens on a wildcard address. **The LLM key does not protect `/api/v1` task, file, or workspace operations, or the separate MCP server.** Before making either port accessible beyond a trusted local environment, put authenticated access controls in front of it. CORS is not an access-control substitute; AM currently allows cross-origin browser requests. See the [remote demo requirements](examples/demo-site/README.md#remote-access).

## API and Commands

The default HTTP origin is `http://127.0.0.1:23333`. Inspect the running instance's [`/openapi.json`](http://127.0.0.1:23333/openapi.json) for routes and schemas; use the compatibility guides for supported protocol behavior and limits.

| Interface               | Paths                                                                                               | Reference                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Anthropic               | `/api/anthropic/v1/messages`, `/api/anthropic/v1/messages/count_tokens`, `/api/anthropic/v1/models` | [LLM compatibility](docs/llm-compatibility.md#endpoints)       |
| OpenAI                  | `/api/openai/v1/chat/completions`, `/api/openai/v1/responses`                                       | [Responses compatibility](docs/openai-responses-api-design.md) |
| Gemini                  | `/api/gemini/v1beta/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`       | [LLM compatibility](docs/llm-compatibility.md#endpoints)       |
| Codex standalone search | `/api/openai/v1/alpha/search`                                                                       | [Search compatibility](docs/llm-compatibility.md#web-search)   |
| Roo and Cline           | `/api/v1/roo/*`, `/api/v1/cline/task`                                                               | [Roo HTTP/SSE](docs/roo-routes-events.md)                      |
| Model discovery         | `/api/v1/lm/chatModels`, `/api/v1/lm/tools`                                                         | Running OpenAPI document                                       |

Use these Command Palette actions to manage the extension:

- **Agent Maestro: Start API Server**, **Stop API Server**, **Restart API Server**, **Get API Server Status**.
- **Agent Maestro: Start MCP Server**, **Stop MCP Server**, **Get MCP Server Status**, **Install MCP Configuration**.
- **Agent Maestro: Get Extensions Status**.
- **Agent Maestro: Set Exa API Key** to configure or clear an optional search-provider key.

## Troubleshooting and Diagnostics

Start with the **Agent Maestro** Output channel. Supported LLM request failures also append diagnostics to a timestamped `*-debug.log` in the first workspace folder when file logging succeeds; the error response includes the path when available.

**Review every log before sharing it.** Known Anthropic message fields are redacted in diagnostic files, but system prompts, tool definitions, unknown fields, and error details can remain. Raw OpenAI/Gemini request bodies are not redacted. Debug-level Output logs are a separate channel and can contain request or response content. See the [logging scope](docs/llm-compatibility.md#diagnostic-logs).

## Development and Further Reading

- [Documentation index](docs/README.md): current guides, runbooks, and dated design records.
- [Testing guide](docs/testing.md) and [contributor instructions](AGENTS.md).
- [Roo extension API notes](docs/roo-code/README.md) and [remote demo](examples/demo-site/README.md).
- [Changelog](CHANGELOG.md), including migration details for older versions.

Potential future work includes code-server deployment support, richer orchestration for Claude Code/Codex, and task scheduling. These are roadmap items, not supported interfaces.

[Report a bug or request a feature](https://github.com/Joouis/agent-maestro/issues).

## License

[MIT](LICENSE).
