# Agent Maestro

[![Visual Studio Marketplace installs](https://badgen.net/vs-marketplace/i/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Visual Studio Marketplace downloads](https://badgen.net/vs-marketplace/d/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)
[![Visual Studio Marketplace rating](https://badgen.net/vs-marketplace/rating/Joouis.agent-maestro)](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro)

Use your preferred coding client with the GitHub Copilot models available in VS Code. Agent Maestro provides a local API bridge for Claude Code, Claude Desktop, Codex, Gemini CLI, and other compatible clients. Model requests use VS Code's Copilot connection and remain subject to your account's model access and usage limits.

For automation, Agent Maestro also exposes Roo Code tasks through REST and MCP: start work, follow progress, and respond to tool approvals from another application. Cline integration currently supports basic task creation.

![Claude Code setup](https://media.githubusercontent.com/media/Joouis/agent-maestro/main/assets/configure-claude-code-demo.gif)

## Features

- **Choose your client and model.** Connect through Anthropic Messages, OpenAI Chat Completions/Responses, or Gemini-compatible endpoints, with setup commands for four clients and a picker of available Copilot models.
- **Work with tools and images.** Supported tool histories and image inputs are converted to VS Code messages. Ordinary client tools still execute in the client; AM does not run them on its behalf.
- **Search for current information.** Exa-backed search supports declared Anthropic/Responses web-search tools and experimental Codex standalone search, with source links and protocol-specific limits.
- **Configure longer conversations.** Claude Code and Codex setup uses the selected model's advertised context window. Streaming heartbeats keep supported clients connected while a response is pending.
- **Automate Roo tasks.** Use HTTP/SSE for task progress and interaction, or the MCP task tool for up to 20 concurrent tasks.

This README and the [documentation index](docs/README.md) describe this checkout. Features in pending `.changeset/` entries may not yet be available in the installed Marketplace release; check the [changelog](CHANGELOG.md) for released versions.

## Quick Start

### Prerequisites

- VS Code **1.120.0 or newer**, with GitHub Copilot signed in and eligible models available. The LLM proxy currently selects models from the `copilot` vendor.
- Install the client you want to use: Claude Code, Claude Desktop, Codex, or Gemini CLI. Installing a client alone does not provide proxy models.
- Install Roo Code or a compatible variant such as Kilo Code only if you need task orchestration. Cline is optional and currently supports task creation only.

For source development, use Node.js 22 or newer and the pnpm version specified in [package.json](package.json).

### 1. Install and Start the Proxy

Install [Agent Maestro from VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Joouis.agent-maestro) or [Open VSX](https://open-vsx.org/extension/Joouis/agent-maestro).

Open your project in VS Code and keep that window running while using the client. The API server starts when Agent Maestro activates, normally at `http://127.0.0.1:23333`.

Run **Agent Maestro: Get API Server Status** from the Command Palette to confirm the server and active port. If it is stopped, run **Agent Maestro: Start API Server**. You do not need the separate MCP server for LLM proxy requests.

### 2. Configure Your Client

Complete **Agent Maestro: Set API Key**, then open the Command Palette and run the relevant client command:

| Client         | Command                                              | Configuration written                                                                             |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Claude Code    | **Agent Maestro: Configure Claude Code Settings**    | Choose `~/.claude/settings.json` or `<workspace>/.claude/settings.local.json`                     |
| Claude Desktop | **Agent Maestro: Configure Claude Desktop Settings** | Platform-specific `Claude-3p/configLibrary` gateway configuration                                 |
| Codex          | **Agent Maestro: Configure Codex Settings**          | `~/.codex/config.toml`                                                                            |
| Gemini CLI     | **Agent Maestro: Configure Gemini CLI Settings**     | Choose `~/.gemini/.env` or `<workspace>/.gemini/.env`, plus `settings.json` in the same directory |

For Claude Code, Codex, or Gemini CLI, choose a model from the picker. If the list is empty, check Copilot sign-in and model availability in VS Code before continuing. Claude Code and Gemini CLI also offer project settings when you want the configuration limited to this workspace.

Run **Agent Maestro: Set API Key** before the client configurator. Set a key, import the previous key, or explicitly choose **Disable HTTP authentication** for a trusted environment. Each configurator asks for and verifies the current key when authentication is enabled, then writes the client credential. Canceling or entering a wrong key leaves client files unchanged. Until server setup is completed, API requests return HTTP 503.

### 3. Get Your First Response

Start a fresh client session so it loads the new configuration. For CLI clients, use a terminal in the configured project directory:

| Client          | Start after configuration                            |
| --------------- | ---------------------------------------------------- |
| Claude Code CLI | Run `claude`                                         |
| Codex CLI       | Run `codex`                                          |
| Gemini CLI      | Run `gemini`                                         |
| Claude Desktop  | Fully quit and reopen the app, then start a new chat |

Send this small connectivity check:

```text
Reply with exactly AM_CONNECTED. Do not read files or use tools.
```

Look for the reply **and** the matching request in VS Code's **Output → Agent Maestro** channel. AM logs an incoming request with its resolved model and a completion with token usage; this confirms the client used the proxy rather than another configured provider. The prompt is a smoke check, not a guarantee of exact model output.

Once connected, try a normal task such as explaining a function in your project. Requests consume model quota, and any tool approvals remain part of the client workflow. If the check fails, see [troubleshooting](#troubleshooting-and-diagnostics). Direct API users can use the [complete request examples](docs/llm-compatibility.md#request-examples).

## Web Search

Search is available when a supported client requests it. AM does not add search to every prompt.

| Client/API path    | How it is enabled                                                                        | What to expect                                                         |
| ------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Anthropic Messages | Client declares `web_search_20250305` and the model selects it                           | At most one search per request; final text with source links           |
| OpenAI Responses   | Client declares stable `web_search` and the model selects it                             | At most one search per request; hosted-search events and URL citations |
| Codex standalone   | **Configure Codex Settings** enables the experimental feature for supported CLI versions | Up to four search queries plus page `open` and `find` operations       |

After configuring a supported Codex release, try asking it to find a recent release announcement and cite its sources. An existing `web_search = "disabled"` setting is preserved; change it to `"live"` if you want to enable search.

Searches can use Exa's anonymous allowance, including domain, recency, country, and cache-only constraints on standalone search. No Exa API key is required; anonymous access remains subject to Exa's rate limits. Run **Agent Maestro: Set Exa API Key** to use your Exa account. Queries and retrieved page URLs are sent to Exa, whose usage limits and billing are separate from Copilot.

These paths have different contracts: Gemini has no hosted-search integration here, and not every native search option or Codex web command is supported. See [search compatibility and supported Codex versions](docs/llm-compatibility.md#web-search).

## Models and Context Windows

- **Claude Code:** Setup writes the selected model's compaction window and defaults the compaction threshold to 85% unless you already set one. For the supported 1M tier, it adds the client-side `[1m]` marker.
- **Codex:** Setup writes `model_context_window` from the selected model's advertised `maxInputTokens`.

AM prefers Copilot-provided usage metadata when available and estimates token counts otherwise. A local estimate can differ from provider usage; see [context-window handling](docs/claude-code-context-window.md) for the exact configuration and limits.

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

### Roo/Kilo and MCP Setup

The MCP server normally uses port `23334` and requires the configured default Roo extension to provide a task manager. If only Kilo Code is installed, set `agent-maestro.defaultRooIdentifier` to `kilocode.kilo-code` and reload VS Code before starting MCP. HTTP task requests can also select an installed variant explicitly with `extensionId`.

**Install MCP Configuration** currently writes `http://localhost:23334/mcp` regardless of the configured port. If you use a custom MCP port, update that URL in the generated client configuration manually after installation.

### Gemini Settings and Existing Overrides

The configurator writes `GOOGLE_GEMINI_BASE_URL`, the verified `GEMINI_API_KEY`, `GEMINI_MODEL`, and `GEMINI_TELEMETRY_ENABLED=false` to the chosen `.gemini/.env`, replacing any stale API key. It also sets `security.auth.selectedType` to `gemini-api-key` in the adjacent `settings.json`.

The configurator warns about a workspace-root `.env` that can override user settings. If Gemini still uses an old endpoint or key, check that file and the launching environment as well as `.gemini/.env`; exported environment values take precedence.

## Access and Authentication

**This is a major-version migration: first use and upgrades from v2.14 require explicit authentication setup.** Run **Agent Maestro: Set API Key** and choose set/replace, import the previous LLM key, or disable authentication. Canceling keeps unconfigured APIs unavailable (HTTP 503). Blank input does not disable authentication. Selecting Disable HTTP authentication opens a confirmation that explains the network exposure and all-window scope. Generated client placeholders do not configure the server. When authentication is enabled, configure the same key in your client, using:

| Route prefix       | Header                        |
| ------------------ | ----------------------------- |
| `/api/v1/*`        | `Authorization: Bearer <key>` |
| `/api/anthropic/*` | `x-api-key: <key>`            |
| `/api/openai/*`    | `Authorization: Bearer <key>` |
| `/api/gemini/*`    | `x-goog-api-key: <key>`       |

Policy and a salted key verifier are stored in `~/.agent-maestro/http-auth.json` on the machine running the extension host. All Agent Maestro windows, profiles, ports, and VS Code installations for that OS user share this policy. The original key is not stored there. On macOS/Linux, the directory must be owned by the current user with mode `0700`, and the file must have mode `0600` (created automatically). A missing, unreadable, or invalid file returns HTTP 503; restore access with **Set API Key** after correcting any directory permission problem. For an existing directory owned by your user on macOS/Linux, run `chmod 700 ~/.agent-maestro` and retry; configuration errors identify the affected directory. The extension does not silently change permissions on an existing directory. Disabling writes an explicit policy; deleting the file does not disable authentication.

Changes affect new requests in all windows; existing tasks and streams may finish. **Import previous LLM API key** is available during setup/recovery and reads the old SecretStorage value only after selection. If it is unavailable, set a new key. Older AM windows are recognized through their legacy discovery endpoint, and the new window monitors the port for takeover (normally within one minute after it becomes free). A warning identifies the old listener: it does not apply the new policy. Update or close that window before relying on the new protection.

`GET /health` is public and returns only a fixed service name and listener status. `/openapi.json` remains public. `/api/v1/info` exposes local home/workspace paths only when the configured policy allows the request.

See [complete request examples](docs/llm-compatibility.md#request-examples).

### Client Credentials

Run the client configurator again after setting or rotating the server key. The password prompt verifies the key before writing it; the server keeps only a verifier and cannot recover the key automatically. The client files contain the actual credential and are created/restricted to mode `0600` on macOS/Linux. Keep them private. When authentication is explicitly disabled, configurators use a placeholder and do not request a key.

| Client         | What the configurator writes                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | `env.ANTHROPIC_API_KEY`; blanks `ANTHROPIC_AUTH_TOKEN` and removes `apiKeyHelper` from the selected file. Project configuration uses `.claude/settings.local.json`.                                                                          |
| Codex          | `model_providers.agent-maestro.http_headers.Authorization = "Bearer <key>"`; removes competing credential sources only from the AM provider and sets `requires_openai_auth = false`. No shell variable is required for this generated setup. |
| Gemini CLI     | `GEMINI_API_KEY` in the selected `.gemini/.env`; replaces an old value and selects `gemini-api-key` in adjacent `settings.json`.                                                                                                             |
| Claude Desktop | `inferenceGatewayApiKey`, `inferenceGatewayAuthScheme = "x-api-key"`, and `inferenceCredentialKind = "static"` in the active AM config-library entry.                                                                                        |

For manual configuration or an existing client setup:

- **Claude Code:** set `ANTHROPIC_API_KEY` in the chosen file's `env`, set `ANTHROPIC_AUTH_TOKEN` to an empty string, and remove a competing `apiKeyHelper`. Keep `ANTHROPIC_BASE_URL=http://127.0.0.1:23333/api/anthropic`. Inspect higher-priority project/managed settings if the key is still overridden. Start a fresh Claude Code process.
- **Codex:** the configurator uses a static Authorization header. For an environment-based alternative, remove that header and other AM provider authentication settings, add `env_key = "AGENT_MAESTRO_API_KEY"` under `[model_providers.agent-maestro]`, and export `AGENT_MAESTRO_API_KEY` with the server key before starting Codex. Keep `base_url = "http://127.0.0.1:23333/api/openai/v1"` and `wire_api = "responses"`. Do not combine the two authentication modes.
- **Gemini CLI:** set `GEMINI_API_KEY='your-server-key'` in the selected `.gemini/.env`, retain `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:23333/api/gemini`, and use `security.auth.selectedType = "gemini-api-key"`. Unset an obsolete exported `GEMINI_API_KEY`, check higher-priority `.env` files, and restart Gemini. Never commit project `.env` credentials. For keys containing mixed quote characters that cannot be written losslessly to dotenv, use a new key or supply it through the process environment.
- **Claude Desktop:** in the platform-specific `Claude-3p/configLibrary` directory, find the AM entry selected by `_meta.json`'s `appliedId`; set `inferenceGatewayApiKey` in `<appliedId>.json`, retain `inferenceProvider = "gateway"`, `inferenceCredentialKind = "static"`, `inferenceGatewayAuthScheme = "x-api-key"`, and `inferenceGatewayBaseUrl = "http://127.0.0.1:23333/api/anthropic"`. Fully quit and reopen Desktop. Managed settings may override the local configuration.

Use the actual proxy port when different. Client reference: [Claude Code gateway credentials](https://code.claude.com/docs/en/llm-gateway-connect), [Codex providers](https://developers.openai.com/codex/config-advanced/), [Gemini environment configuration](https://geminicli.com/docs/reference/configuration/), and [Claude Desktop configuration](https://claude.com/docs/third-party/claude-desktop/configuration).

### Remote Access

The HTTP server listens on a wildcard address. The API key protects `/api/v1` control operations and all LLM-compatible APIs. **It does not protect the separate MCP server.** Explicitly disabling HTTP authentication makes the HTTP APIs public. Before exposing either port beyond a trusted environment, configure authentication and TLS through a trusted gateway; protect MCP separately. CORS is not access control. See the [remote demo requirements](examples/demo-site/README.md#remote-access).

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
- **Agent Maestro: Set API Key** to set/import a key or explicitly disable HTTP authentication.
- **Agent Maestro: Set Exa API Key** to configure or clear an optional search-provider key.

## Troubleshooting and Diagnostics

| Symptom                                       | First check                                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Connection refused                            | Keep the VS Code window open; check **Get API Server Status** and the client's configured port.             |
| No models in the setup picker                 | Check Copilot sign-in, model access, and model-discovery messages in AM Output.                             |
| HTTP 401                                      | Match the server key and route header; control APIs use `Authorization: Bearer <key>`.                      |
| HTTP 503 authentication busy                  | Wait at least the `Retry-After` interval (one second) and retry; do not reset your key.                     |
| HTTP 503 authentication unavailable           | Run **Set API Key** for setup/recovery; if already configured, check the policy file permissions and retry. |
| Client answers but AM has no matching request | Start a new client session and inspect its active provider/base URL and project/environment overrides.      |
| MCP unavailable with Kilo                     | Select Kilo as the default Roo extension and reload; check the generated MCP URL for custom ports.          |

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
