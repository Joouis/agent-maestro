# Anthropic Server Web Search Design

## Problem

Agent Maestro exposes an Anthropic-compatible `POST /v1/messages` endpoint
backed by the VS Code Language Model API. Anthropic clients can request the
server-side web search tool:

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5
}
```

The VS Code API does not execute Anthropic server tools. Agent Maestro currently
drops them, so clients such as Claude Code cannot use their expected WebSearch
capability through the proxy.

Installing Exa MCP directly in every client can provide web search, but it does
not make the `/v1/messages` endpoint compatible with Anthropic's server-tool
contract. This feature fills that protocol gap by executing requested searches
inside Agent Maestro.

## Goals

- Support `web_search_20250305` on `POST /v1/messages`.
- Execute search only when the request explicitly declares the server tool and
  the model chooses to call it.
- Use Exa MCP as the initial search provider, with anonymous access or an
  optional user API key.
- Return a final model answer with source URLs without requiring the client to
  execute the search.
- Preserve existing client-defined tools and serialize turns that request web
  search and client tools together.
- Isolate untrusted search results from client tools and further outbound
  searches.
- Apply a shared output budget, cancellation, usage accounting, and credential
  protection.

## Non-goals

- Automatically inject web search into requests that did not ask for it.
- Reproduce Anthropic's encrypted search payloads or citation metadata.
- Expose internal `server_tool_use` or `web_search_tool_result` blocks.
- Support `web_fetch_*`, dynamic filtering, code execution, or newer web search
  versions in the first release.
- Replace Claude Code's built-in `WebFetch` tool.
- Add web search to OpenAI or Gemini endpoints in the first release.
- Provide exact byte-for-byte parity with Anthropic's API.

## API Scope

The first release recognizes only this server tool:

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 5,
  "allowed_domains": ["example.com"],
  "user_location": {
    "type": "approximate",
    "country": "US"
  }
}
```

Accepted fields:

| Field                   | Behavior                                                    |
| ----------------------- | ----------------------------------------------------------- |
| `max_uses`              | Applied to the per-request provider call budget             |
| `allowed_domains`       | Mapped to Exa advanced search                               |
| `blocked_domains`       | Mapped to Exa advanced search                               |
| `user_location.country` | Mapped to Exa advanced search `userLocation`                |
| `cache_control`         | Accepted and ignored for SDK compatibility                  |
| `strict`                | Accepted; Agent Maestro always validates the internal input |
| `allowed_callers`       | Validated; only direct calls are accepted                   |
| `defer_loading`         | Validated; only omitted or `false` is accepted              |

Validation rules:

- `null` is treated the same as omission for nullable SDK fields.
- `max_uses` must be a positive integer when provided.
- `allowed_domains` and `blocked_domains` are mutually exclusive and contain
  plain hostnames only. Paths are not supported in the first release.
- `user_location.type` must be `approximate`; only a two-letter ISO country code
  is supported. Requests containing `city`, `region`, or `timezone` return
  `400 invalid_request_error`.
- `cache_control` is accepted and ignored because Agent Maestro cannot forward
  Anthropic cache breakpoints to the VS Code Language Model API.
- `strict` is accepted. Agent Maestro validates the internal search input
  regardless of its value.
- `allowed_callers` may be omitted or contain only `"direct"`. Code-execution
  callers are not supported.
- `defer_loading` may be omitted or `false`; `true` is not supported because
  Agent Maestro does not implement Anthropic tool search.
- Unsupported web search versions and options return
  `400 invalid_request_error` rather than being silently ignored.

A normal client tool named `WebSearch` or `web_search` with an `input_schema`
remains a client tool. It must not be intercepted based on its name alone.

### Tool Choice

`tool_choice` applies to the first model decision in each client request:

| Anthropic choice                | First model round                                                                               | After an executed hidden search attempt                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Omitted or `{type: "auto"}`     | Expose all supported server and client tools in automatic mode                                  | Expose no tools and synthesize the response                                             |
| `{type: "none"}`                | Expose no tools                                                                                 | Not applicable                                                                          |
| `{type: "any"}`                 | Expose all supported tools in required mode                                                     | Expose no tools and synthesize the response                                             |
| `{type: "tool", name:"<name>"}` | Resolve `<name>` against the available classified tools; expose only that tool in required mode | If it is server search, synthesize without tools; otherwise return the client tool call |

Agent Maestro resolves a named choice in this order:

1. Classify each declaration as supported server search, client tool, or
   unsupported server tool.
2. Remove server search when it is disabled or blocked by the search-isolation
   policy.
3. Match the requested name against the remaining server and client tools.
4. Select the tool only when exactly one candidate remains.

If no candidate remains, the request returns `400 invalid_request_error` with
`tool_not_found` or `tool_unavailable` as appropriate. If a server search and a
client tool share the requested name and are both available, the request returns
`400 invalid_request_error` with `ambiguous_tool_choice`.

After one hidden search attempt, whether it succeeds or returns an error, Agent
Maestro makes one tool-free synthesis request. This allows the model to produce
a final response or explain the failure without giving untrusted search content
access to another tool.

The VS Code Language Model API supports only `Auto` and `Required`; it cannot
require a tool by name. Agent Maestro implements a named choice by narrowing the
tool list to the single resolved tool and setting the mode to `Required`. Mapping
a named choice to `Required` without narrowing the list is incorrect because the
model could select a different tool.

The VS Code Language Model API cannot reliably enforce Anthropic's
`disable_parallel_tool_use` constraint. Any request containing
`disable_parallel_tool_use: true` returns `400 invalid_request_error`. For
`auto`, `any`, and named choices, omitted or `false` values are accepted. The
field must be omitted for `{type: "none"}`.

## Design

### Components

| Component              | Responsibility                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| Server-tool classifier | Separate supported Anthropic server tools from client tools                    |
| Web search provider    | Execute a normalized search request and return bounded results                 |
| Exa MCP provider       | Connect to Exa, invoke the appropriate search tool, and normalize its response |
| Anthropic tool loop    | Coordinate model calls, provider calls, client tools, limits, and cancellation |
| Anthropic serializer   | Produce non-streaming responses and SSE events                                 |

The model-facing tool uses an internal, collision-resistant name. The mapping
between that name and Anthropic's `web_search` is kept inside the request and is
never exposed as a client tool.

The internal tool schema contains only a required `query` string with a length
of 2 to 2,000 characters. Invalid model-generated input becomes a hidden
`invalid_tool_input` result followed by tool-free synthesis. Search limits,
domain filters, location, and result size come from the validated request and
Agent Maestro policy rather than model-generated arguments.

### Normal Search Flow

```text
Client /v1/messages request
  -> classify server and client tools
  -> convert web_search to an internal VS Code function tool
  -> send request to the VS Code language model
  -> model optionally calls the internal search tool
  -> execute at most one Exa MCP search
  -> append the tool call and normalized result to the hidden model history
  -> send one tool-free synthesis request
  -> return the consolidated Anthropic response
```

The internal tool calls and results are not returned to the client. Text emitted
across hidden model rounds is retained in chronological order. The client
receives those text blocks and the final answer, but no internal tool blocks.
Because no `web_search_result` block is emitted, Agent Maestro does not need to
produce Anthropic's required `encrypted_content`.

### Source Presentation

The model is instructed to cite source URLs from the normalized tool result.
When a request ends with `stop_reason: "end_turn"`, the serializer appends a
deduplicated `Sources` list for any used result URL that is missing from the
model text. Only validated `http` and `https` URLs are included. This provides
source visibility within the shared output budget without claiming
Anthropic-native citations.

### Mixed Server and Client Tools

If the model requests web search and client tools in the same response, Agent
Maestro prioritizes the client tools:

1. Do not execute or return the internal web search calls.
2. Preserve all client-visible text and client `tool_use` blocks in their
   original order, with `stop_reason: "tool_use"`.
3. Wait for the client to return the corresponding `tool_result` blocks.
4. On the immediate tool-result continuation request, do not expose web search.
5. Allow web search again only after a later user message containing no
   `tool_result` blocks.

Only internal search call blocks are removed. Text emitted alongside the client
tool calls, including explanatory preambles, remains visible to the client. This
avoids leaking an internal tool call that the client cannot execute without
discarding legitimate model output, and keeps the proxy stateless. It does not
reproduce Anthropic's deferred server-tool state machine.

### Search Isolation

Search results are untrusted input. Once a provider result or provider error
enters the hidden model history:

- The synthesis request exposes no internal or client tools.
- The model cannot initiate another Exa request in the same client request.
- The model cannot request workspace, shell, MCP, or other client-tool data in
  the same client request.

When the latest user message contains one or more client `tool_result` blocks,
Agent Maestro removes the internal web search tool before model execution. If
the remaining classified tools contain a client tool named `web_search`, a named
choice selects that client tool normally. A request returns
`400 invalid_request_error` only when a named choice has no available match, or
when `any` leaves no available tool. Automatic and `none` choices continue
without server search.

This is a deliberately narrow information-flow boundary for the first release.
It avoids per-query approval UI and cross-request provenance tracking.

### Search Provider Contract

The tool loop depends on a provider-neutral interface:

```ts
interface WebSearchRequest {
  query: string;
  maxResults: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    country: string;
  };
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

interface WebSearchProvider {
  search(
    request: WebSearchRequest,
    signal: AbortSignal,
  ): Promise<WebSearchResult[]>;
}
```

The provider interface is a test seam and keeps MCP details out of the
Anthropic tool loop; runtime provider selection is not part of the first
release.

The Exa implementation uses a standard Streamable HTTP MCP client with:

- Endpoint
  `https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa`.
- MCP initialization, `notifications/initialized`, tool discovery, negotiated
  protocol version, and session ID handling.
- `x-api-key` authentication when the user configured a key.

It maps:

- Simple requests to `web_search_exa`.
- Requests with domain filters or a country to `web_search_advanced_exa`.
- `user_location.country` to Exa's `userLocation`.

Provider output is normalized before it enters the model context. Raw MCP
protocol messages and credentials are never model-visible. Non-HTTP(S) result
URLs are discarded.

### Limits

Each request enforces:

- At most one provider call. `max_uses` is accepted for API compatibility, but
  the effective call budget is `min(max_uses ?? 1, 1)`.
- At most two model rounds: tool selection and tool-free synthesis.
- At most five normalized results and 8,000 characters of result context per
  provider call.
- A 60-second provider timeout within the existing request timeout.
- The existing request timeout and client-disconnect cancellation.

If the model emits multiple parallel internal search calls, Agent Maestro
executes only the first call in content order. Remaining calls receive hidden
`max_uses_exceeded` tool errors so every tool call has a matching result. A
failed provider attempt consumes the single-call budget.

Request validation or an explicitly required unavailable search returns an
Anthropic-compatible API error before model execution. The Exa MCP client
initializes lazily when the model first calls search. Initialization,
tool-discovery, authentication, rate-limit, timeout, and protocol failures
therefore become hidden tool errors followed by tool-free synthesis.

The provider cancellation signal combines the client disconnect, the overall
request lifecycle, and the provider timeout.

### Streaming

The internal tool loop must consume the first model response before it knows
whether to execute search and run synthesis. For `stream: true`, Agent Maestro
therefore:

1. Buffers internal model and search rounds.
2. Continues sending the existing heartbeat while waiting.
3. Preserves client-visible text in chronological order.
4. Emits one valid Anthropic SSE stream for the consolidated result.

The stream remains protocol-compatible but does not expose real-time Exa
progress. Client disconnects cancel the active model and provider requests.

### Usage

The request's `max_tokens` is a shared output budget across hidden model rounds.
Before each round, Agent Maestro passes the remaining budget to the VS Code
model. After each round, it subtracts the actual output usage. If no budget
remains before synthesis, Agent Maestro skips the provider call and synthesis
round, returns the accumulated client-visible text, and sets
`stop_reason: "max_tokens"`.

The serializer appends source entries only while they fit in the remaining
budget. If a complete entry does not fit, it is omitted; source entries are
never partially truncated, and the response uses `stop_reason: "max_tokens"`.
Serializer-added source tokens are counted in `output_tokens`.

Usage returned to the client aggregates both VS Code model rounds:

```json
{
  "server_tool_use": {
    "web_search_requests": 1,
    "web_fetch_requests": 0
  }
}
```

Input, output, cache-read, and cache-creation token counters are summed across
all hidden model rounds. `web_search_requests` counts provider calls that were
actually dispatched, including a failed call. Calls skipped for a mixed response
or exhausted output budget do not increment it. `server_tool_use` remains `null`
when no provider call occurs.

Anonymous Exa limits and Exa API billing are separate from model token usage.
Agent Maestro does not claim Anthropic's native web search pricing semantics.

### Configuration and Security

- `agent-maestro.anthropicWebSearch.enabled` defaults to `false`. Users must
  explicitly enable it before any query can leave their environment.
- While disabled, Agent Maestro removes the supported server tool and otherwise
  preserves current request behavior. It returns `400 invalid_request_error`
  only when a named choice has no remaining classified match, or when `any`
  leaves no available tool. A same-named client tool remains selectable.
- After enablement, no Exa credential is required: search uses Exa's anonymous
  MCP allowance by default.
- An Exa API key is stored in VS Code SecretStorage and sent in a request
  header, never in the MCP URL.
- `Agent Maestro: Set Exa API Key` sets, replaces, or clears the key without
  logging it. Clearing the key returns to anonymous access.
- Search queries and URLs leave the local environment and are sent to Exa.
- Search results are untrusted content and are inserted only as delimited tool
  results that explicitly instruct the model to treat them as evidence and
  ignore embedded instructions. They are never inserted as system instructions.
- Agent Maestro does not automatically add workspace contents, file contents,
  or credentials to a search query.
- Credentials, full provider responses, and fetched page content are not
  written to diagnostic logs.

## Limitations

- Internal search calls and results are omitted from the response. Clients that
  need to inspect or persist the native server-tool transcript are not
  supported.
- Each client request can perform at most one search.
- Search snippets are not restored on later turns. The model receives the prior
  final answer and source URLs and may search again when more detail is needed.
- A model response that contains both search and client tool calls executes only
  the client tools in that turn. Search is unavailable on the immediate
  tool-result continuation.
- Client tools and additional searches are unavailable after a search result
  enters the hidden context. Claude Code cannot automatically perform
  `WebSearch` followed by client-side `WebFetch` in one request.
- The first release provides source links but not Anthropic-native search result
  or citation objects.
- Domain filters containing paths and location fields other than country are
  rejected.
- Exa result ranking, freshness, filtering, and availability differ from
  Anthropic's search provider.
- Anonymous Exa usage is unsuitable for guaranteed or high-volume workloads.
- Streaming begins after the hidden tool loop completes, apart from heartbeat
  events.
- Server-side WebFetch and dynamic filtering remain unsupported.

## Acceptance Criteria

1. Requests containing only client tools and no supported server web search
   behave exactly as before.
2. A request that declares `web_search_20250305` can produce a current,
   search-grounded answer with a deterministic, deduplicated source URL list
   when the response completes within its output budget.
3. Search runs only when selected by the model and never through automatic tool
   injection.
4. A request executes at most one provider call and two model rounds.
5. Client tools continue to work. If a model response contains both client and
   internal search calls, only the internal search call blocks are removed;
   client-visible text and client tool calls retain their original order, and
   the immediate tool-result continuation does not expose search.
6. A normal client tool named `WebSearch` or `web_search` is not intercepted and
   remains selectable when server search is unavailable.
7. `tool_choice` correctly handles `none`, `auto`, `any`, named web search, and
   named client tools; an executed search is followed by a tool-free synthesis
   round, including after a failed provider attempt.
8. A named tool choice resolves after classification and availability filtering,
   narrows the VS Code tool list to exactly one tool before using required mode,
   and rejects genuinely ambiguous same-name candidates.
9. `disable_parallel_tool_use: true` returns `400 invalid_request_error`;
   omitted and `false` values are accepted for `auto`, `any`, and named choices,
   while `{type: "none"}` must omit the field.
10. Invalid domain, location, and unsupported web search options return
    `400 invalid_request_error`.
11. Valid SDK metadata is handled consistently: `cache_control` is accepted and
    ignored, `strict` is accepted, nullable fields accept `null`, and unsupported
    caller or deferred-loading modes return `400 invalid_request_error`.
12. Web search performs no outbound request until the user explicitly enables
    `agent-maestro.anthropicWebSearch.enabled`. While disabled, automatic tool
    declarations are ignored without failing ordinary requests; an explicitly
    required unavailable search returns `400 invalid_request_error`.
13. Non-streaming and streaming responses are valid Anthropic Messages API
    responses; streaming retains heartbeat behavior during search.
14. Usage aggregates all hidden model rounds and reports only dispatched search
    requests according to the documented counting rules.
15. The total output, including hidden model rounds and appended sources, does
    not exceed the request's `max_tokens`; exhaustion returns
    `stop_reason: "max_tokens"`.
16. Request validation and explicitly required disabled-search failures return
    an API error; Exa MCP failures after a model search call become hidden tool
    errors and allow the model to respond.
17. Exa failures are surfaced without leaking credentials or producing a false
    successful search result.
18. Responses contain no `web_search_result`, fabricated `encrypted_content`,
    `encrypted_index`, or Anthropic-native citation claims.
19. Search-result isolation tests prove that the synthesis round exposes no
    tools and that immediate client-tool continuations cannot invoke search.
20. Unit tests cover classification, validation, tool choice, normal search,
    source serialization, mixed-tool serialization, output budgeting, provider
    errors, usage, streaming, and cancellation.
21. An end-to-end `/v1/messages` test covers the complete hidden loop with a
    mock provider, and manual Claude Code smoke tests cover anonymous Exa and an
    optional user API key.
