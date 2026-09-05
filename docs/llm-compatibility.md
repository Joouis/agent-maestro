# LLM Proxy Compatibility

Current-checkout reference, reviewed on 2026-09-05. This describes Agent Maestro's implementation, not full upstream API parity. Consult the [changelog](../CHANGELOG.md) and pending [changesets](../.changeset/) to distinguish released features from source changes.

For installation, client setup, ports, and authentication scope, start with the [README](../README.md). Only Copilot-vendor models are currently eligible for generation; client model IDs use exact/fuzzy matching followed by the configured or automatic fallback.

## Endpoints

All paths below are relative to `http://127.0.0.1:23333` by default.

| Protocol            | Method and path                                                              | Purpose                                   |
| ------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| Anthropic           | `POST /api/anthropic/v1/messages`                                            | Text/tool generation, optionally streamed |
| Anthropic           | `POST /api/anthropic/v1/messages/count_tokens`                               | Local token estimate                      |
| Anthropic           | `GET /api/anthropic/v1/models` and `GET /api/anthropic/v1/models/{model_id}` | Model metadata for compatible clients     |
| OpenAI Chat         | `POST /api/openai/v1/chat/completions`                                       | Chat and client-tool generation           |
| OpenAI Responses    | `POST /api/openai/v1/responses`                                              | Responses items and streaming events      |
| Gemini              | `POST /api/gemini/v1beta/models/{model}:generateContent`                     | Non-streaming generation                  |
| Gemini              | `POST /api/gemini/v1beta/models/{model}:streamGenerateContent`               | Streaming generation                      |
| Gemini              | `POST /api/gemini/v1beta/models/{model}:countTokens`                         | Local token estimate                      |
| Codex compatibility | `POST /api/openai/v1/alpha/search`                                           | Experimental standalone web search        |

The running [`/openapi.json`](http://127.0.0.1:23333/openapi.json) lists routes. Some LLM bodies deliberately use permissive schemas; the support rules below and the [Responses reference](openai-responses-api-design.md) describe limits that a generic schema does not capture.

## Request Examples

Replace each example model with an available Copilot model. `YOUR_LLM_API_KEY` means the key set with **Agent Maestro: Set LLM API Key**; omit that header if server authentication is disabled. These requests generate model output and consume model quota.

### Anthropic

```bash
curl --fail-with-body http://127.0.0.1:23333/api/anthropic/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: YOUR_LLM_API_KEY' \
  -d '{"model":"claude-sonnet-4.6","max_tokens":64,"messages":[{"role":"user","content":"Reply with OK."}]}'
```

### OpenAI Chat

```bash
curl --fail-with-body http://127.0.0.1:23333/api/openai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_LLM_API_KEY' \
  -d '{"model":"gpt-5.5","messages":[{"role":"user","content":"Reply with OK."}]}'
```

### OpenAI Responses

```bash
curl --fail-with-body http://127.0.0.1:23333/api/openai/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_LLM_API_KEY' \
  -d '{"model":"gpt-5.5","input":"Reply with OK.","max_output_tokens":64}'
```

### Gemini

```bash
curl --fail-with-body http://127.0.0.1:23333/api/gemini/v1beta/models/gemini-3.5-flash:generateContent \
  -H 'Content-Type: application/json' \
  -H 'x-goog-api-key: YOUR_LLM_API_KEY' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with OK."}]}]}'
```

## Content, Tools, and History

The proxy converts messages to VS Code LM parts. It does not execute ordinary client function/custom tools; the client must execute them and return their results. Hosted web search is the explicit exception described below.

- Text and supported base64 image inputs become text/data parts. URL-only images and unsupported content may become textual metadata rather than fetched content. Anthropic document blocks are skipped; OpenAI `input_file` is serialized as JSON. Do not assume these fallbacks provide the model with the referenced file.
- Anthropic client tools with `input_schema` remain client tools, including tools named `WebSearch` or `web_search`. Unsupported server tools are filtered; unsupported web-search versions/options are rejected.
- Chat supports function and custom call histories. Responses additionally supports custom/namespace declarations and Codex collaboration items; see its [support table](openai-responses-api-design.md#supported-rejected-and-ignored-inputs).
- Gemini IDs may be omitted. Explicit result IDs are matched first, then same-name ID-less results use FIFO within the current tool-call turn. They cannot consume future calls.

Complete inbound snapshots are normalized before dispatch. Calls without results become short execution-status-unknown notes; orphaned results retain ordinary context. Identical same-turn duplicates are merged, while conflicting calls/results remain conflict context. Complete pairs across turns survive with unique upstream IDs when needed. Wrong-role Anthropic tool blocks also become context; results retain supported media and error status.

Normalization does not execute tools, summarize result bodies, rewrite client sessions, or change newly generated response IDs. The [normalization design](2026-09-04-tool-history-normalization-design.md) specifies turn boundaries and conflict rules. Gemini Live/NON_BLOCKING incremental results are outside this finite-history contract.

## Usage, Context, and Reasoning

| Topic              | AM behavior                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Usage              | Prefer Copilot-provided input/output/cache/reasoning counters when available; use local counting otherwise. Fallback cache counters are zero.          |
| Counting endpoints | Anthropic `count_tokens` and Gemini `countTokens` estimate the serialized request body with `client.countTokens`; they do not resolve provider caches. |
| Cache hints        | Anthropic `cache_control`, OpenAI `prompt_cache_key`, and Gemini `cachedContent` do not create provider cache entries through AM.                      |
| Context window     | Copilot request configuration uses the selected model's `maxInputTokens`. The Claude Code/Codex configurators also use that metadata.                  |
| OpenAI effort      | Chat `reasoning_effort` and Responses `reasoning.effort` enter Copilot configuration; application depends on the selected model/provider.              |
| Anthropic effort   | `output_config.effort` is forwarded, but the last verified Copilot Anthropic path did not apply it.                                                    |
| Gemini thinking    | AM does not map `thinkingConfig.thinkingLevel` into an effective Copilot reasoning-effort setting.                                                     |

Local estimates may differ from provider usage. Claude Code compaction settings and the 1M marker are documented in [context-window handling](claude-code-context-window.md). Provider behavior can change independently of AM; recheck model-specific effort handling when updating compatibility claims.

## Streaming and Cancellation

The [heartbeat note](2026-08-11-sse-heartbeats.md) is authoritative for wire frames: Anthropic uses ping events, Chat uses comments, Responses uses JSON `keepalive` events, and Gemini uses blank lines. Heartbeats do not add generated content or extend request deadlines.

Anthropic Messages, both OpenAI generation endpoints, and Gemini **streaming** cancel unfinished requests after ten minutes or on client disconnect. Non-streaming timeouts on the first three return HTTP 504. Open Anthropic/OpenAI streams use their error events; Gemini sends a final ordinary SSE data frame containing error text and a candidate with `finishReason: "OTHER"`, then closes. A client disconnect closes the stream without a replacement response. Do not infer the same lifecycle guarantee for Gemini non-streaming generation or token-count endpoints.

## Web Search

Configure an optional Exa key with **Agent Maestro: Set Exa API Key**. Queries and result/page URLs leave the local environment and are sent to Exa. Search is selected explicitly through declared hosted tools or Codex commands; AM does not automatically attach workspace files. Provider billing and anonymous limits are independent of Copilot model usage.

| Contract                | Trigger                                           | Output and limits                                                                                                                                                         |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic hosted search | Declare `web_search_20250305`                     | At most one Exa search and a tool-free synthesis round; normal text plus bounded `Sources` links, not native encrypted search/citation blocks.                            |
| Responses hosted search | Declare `web_search` or `web_search_2025_08_26`   | At most one Exa search and a tool-free synthesis round; `web_search_call` items, source URLs, URL citations, and hosted-tool events. Tested scope is GPT-5-family models. |
| Codex standalone search | Codex sends `web.run` commands to `/alpha/search` | Up to four queries, direct/reference `open`, and literal `find`; AM returns tool text and does not run a model loop.                                                      |

Hosted search accepts domain filters and country-level location, but rejects unsupported options. Anthropic allow/block lists are mutually exclusive; Responses permits both. Hosted searches use at most five results and 8,000 characters of evidence; the response output budget is shared across model rounds. Mixed client/server tool calls prioritize client tools, and immediate client-tool-result continuations cannot initiate hosted search. Search synthesis exposes no further tools.

Responses `external_web_access: false` is rejected. Standalone cache-only search is a different contract: it uses authenticated Exa Search API retrieval, and `open`/`find` can use only pages already cached in the current extension process. Domain, recency, country, or cache-only standalone searches require an Exa key; unconstrained searches can use anonymous MCP access.

### Codex Standalone Configuration

The experimental protocol was verified against Codex `0.151.0-alpha.7.1`. Run **Agent Maestro: Configure Codex Settings**, or merge the following into an existing configuration (do not replace unrelated settings):

```toml
model_provider = "agent-maestro"
web_search = "live"

[features]
standalone_web_search = true

[model_providers.agent-maestro]
name = "Agent Maestro"
base_url = "http://127.0.0.1:23333/api/openai/v1"
wire_api = "responses"
supports_standalone_web_search = true
```

Use the model selected by the configurator. `click`, image search, screenshots, finance, weather, sports, and time commands return recoverable unsupported results. Malformed requests return 400; valid but unavailable operations return explanatory tool output. References and page text are bounded, kept in process memory, and expire after 30 minutes idle or restart.

Direct page targets must be public HTTP(S) URLs. Local DNS/address checks are defense in depth, not a guarantee against provider-side SSRF or DNS rebinding: Exa fetches with its own resolver.

Protocol rationale and exact validation rules: [Anthropic search](2026-08-26-anthropic-server-web-search-design.md), [Responses search](2026-08-30-openai-responses-web-search-design.md), [standalone search](2026-08-31-codex-standalone-web-search-design.md).

## Diagnostic Logs

Supported LLM generation failures can append JSON diagnostics to one timestamped `*-debug.log` per extension session in the first workspace folder. The file is created on the first logged error, not merely on startup. If no workspace or writable location exists, file logging can fail; the response includes a log path only when available.

| Channel/field                              | Redaction boundary                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Diagnostic `requestBody`, Anthropic        | Known `messages` content is redacted. System prompts, tool definitions, unknown fields/blocks, and some metadata remain. |
| Diagnostic `requestBody`, OpenAI/Gemini    | Raw request body is retained.                                                                                            |
| Diagnostic `lmChatMessages`, all protocols | Text/tool bodies are removed; names, IDs, roles, and structural metadata remain.                                         |
| Diagnostic `error`, all protocols          | Error text, stack, and raw error metadata can remain.                                                                    |
| Debug-level Output channel                 | Separate from file sanitization; can include request/response content.                                                   |
| Search-provider/normalizer summaries       | Dedicated summaries use counts/categories; this does not sanitize the other channels above.                              |

Review logs from **every protocol** before sharing them. Keep `*-debug.log` out of source control. A successful response or a redacted message field is not a guarantee that all diagnostics are content-free.
