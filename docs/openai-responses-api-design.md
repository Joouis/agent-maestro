# OpenAI Responses Compatibility

Current-checkout reference, reviewed on 2026-09-05. The filename is retained for existing links. See [LLM compatibility](llm-compatibility.md) for setup, request examples, usage, logging, and shared history rules.

## Request and Response

`POST /api/openai/v1/responses` accepts `input` as text or an array of message/tool items, with optional `instructions`. AM translates this snapshot through VS Code's Language Model API and returns Responses output items or SSE events. It does not expose the whole native OpenAI Responses service.

Send the complete conversation history on each request. The Responses endpoint does not persist response objects. Codex standalone search has separate bounded reference state; that does not enable Responses server-side conversation storage.

## Supported, Rejected, and Ignored Inputs

| Input                                                         | AM behavior                                                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text messages and `instructions`                              | Converted to VS Code messages; system/developer instructions use the VS Code user-role representation.                                             |
| Function tools/calls/results                                  | Supported with complete-history normalization.                                                                                                     |
| Custom tools/calls/results                                    | Raw string input is preserved and returned as `custom_tool_call`.                                                                                  |
| Namespace tools                                               | Nested function/custom tools are registered under encoded names and decoded to namespace + bare name on output.                                    |
| `additional_tools` input items                                | Tool declarations are merged into the effective request tool set.                                                                                  |
| Codex `agent_message`                                         | Plaintext content is retained with author/recipient provenance. Opaque `encrypted_content` cannot be used by VS Code LM.                           |
| Base64 `input_image`                                          | Supported, including recognized image parts in function/custom outputs.                                                                            |
| URL/file-ID images and `input_file`                           | Serialized as textual metadata; AM does not fetch the referenced content.                                                                          |
| Stable `web_search`, `web_search_2025_08_26`                  | Hosted Exa-backed search with URL citations; see below.                                                                                            |
| Preview/unknown `web_search*` declarations                    | Rejected with HTTP 400, including `web_search_preview`.                                                                                            |
| Other hosted tools, e.g. file search/code interpreter/MCP     | Filtered out; a choice that requires an unavailable tool can be rejected.                                                                          |
| `previous_response_id`, `conversation`                        | Nonempty values are rejected with HTTP 400; send history in `input`.                                                                               |
| Standalone `item_reference` input item                        | Logged and skipped; it cannot retrieve a stored response item.                                                                                     |
| `reasoning.effort`                                            | Passed into Copilot configuration; application depends on the model. Compatible host runtimes also preserve encrypted reasoning state.             |
| `include: ["web_search_call.action.sources"]`                 | Adds normalized consulted URLs to hosted-search output. Unsupported search-specific includes are rejected in the applicable search path.           |
| `prompt_cache_key`                                            | Forwarded verbatim to Copilot as the conversation ID; prompt cache hits depend on Copilot's `chat.responsesApi.promptCacheKey.enabled` experiment. |
| Other `include` values, `store`, `background`, `service_tier` | Do not enable the corresponding OpenAI service feature. AM does not persist responses or start background jobs.                                    |

The capability table concerns this endpoint. Chat Completions has its own representation and supports function/custom call histories and `reasoning_effort`; it is not limited to the old function-only format.

Custom tools are presented to VS Code LM with a JSON object schema requiring a
string `input` containing the complete raw tool input. This matches replayed
custom-call history; responses unwrap the string into `custom_tool_call.input`.
When namespaces are flattened, namespace instructions are prepended to each
child tool's description so they remain available to the model. Custom-tool
`format` grammars are not enforced by this JSON wrapper.

## Tool Choice

| Choice                                      | Behavior                                                             |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `auto` / omitted                            | Expose supported tools in automatic mode.                            |
| `none`                                      | Expose no tools.                                                     |
| `required`                                  | Require a tool from the available set.                               |
| Named function/custom                       | Narrow the available set to the resolved tool and use required mode. |
| Specific supported web search               | Select only hosted search in required mode.                          |
| `allowed_tools` with declared server search | Rejected; AM does not partially interpret that combination.          |

`parallel_tool_calls: false` is accepted and echoed for Codex compatibility. It does not guarantee that the model emits only one client tool call; hosted search independently enforces its single-dispatch limit.

## Hosted Web Search

Stable search is implemented. Search produces a public `web_search_call` item, final text, and `url_citation` annotations. These are synthesized from Exa sources, not OpenAI-native ranking or claim-level citations. Other annotations remain empty. The tested model scope is GPT-5-family models; AM does not enforce this by model-name matching.

The [LLM search guide](llm-compatibility.md#web-search) covers configuration and limits. The [search design](2026-08-30-openai-responses-web-search-design.md) records exact option validation, output budgeting, isolation, and success/failure event order. Codex's experimental `/alpha/search` endpoint is a distinct contract.

## Streaming and Errors

Lifecycle events begin with `response.created` and `response.in_progress`. Output-item and content events carry the generated data, followed by the appropriate terminal response. Text deltas reconstruct the final text, including serializer-added source links. Custom tools use `response.custom_tool_call_input.*`; functions use `response.function_call_arguments.*`.

JSON and SSE preserve source ordering equally, whether or not reasoning is present. Text before and after a tool call remains in separate message items; non-streaming responses no longer concatenate that text ahead of the tool call.

JSON `keepalive` events maintain Codex's SSE idle timer without replacing the OpenAI SDK's accumulated response. See [SSE heartbeats](2026-08-11-sse-heartbeats.md) for wire format, sequence numbers, and terminal ordering.

- Invalid supported-contract inputs return structured HTTP 400 errors before dispatch.
- Model resolution with no available fallback returns 404.
- Other failures return 500; unfinished requests time out after ten minutes, returning 504 before streaming.
- Open streams use `response.failed` for errors/timeouts. Hosted-search output-budget exhaustion uses `response.incomplete` rather than successful completion.
- A failed Exa attempt can yield a failed search item and a completed explanatory answer. Inspect item status as well as HTTP status.

## Reasoning State

AM declares no proposed APIs and requires no proposal-enabling flags. Some released VS Code/Copilot versions expose thinking constructors and the `includeEncryptedThinking` option at runtime before they appear in stable TypeScript declarations. AM uses local types and checks those constructors before use. VS Code 1.141.2 or newer is recommended for reasoning replay; the verified combination is VS Code 1.141.2 / Copilot 0.69.0. This is not a minimum-version claim or a guarantee for every host/provider combination. The extension's installation requirement remains unchanged.

When the host exposes thinking parts, Responses requests ask Copilot for encrypted thinking. AM returns supported Responses-origin state as `reasoning` output items in both JSON and SSE. Its client-opaque `encrypted_content` envelope preserves the original provider ID together with the original ciphertext because Codex omits item IDs on replay. Send this field back unchanged with the full conversation and tool results. AM reconstructs assistant thinking parts with the original provider ID, ciphertext, and Responses origin marker before dispatch. Hosted-search synthesis also retains this state between its internal model rounds.

The state is opaque: AM does not decrypt it, manufacture reasoning, or turn private thinking text into visible summaries. Reasoning-token usage is separate from replayable state. Summary-only items are skipped with a debug diagnostic; malformed encrypted input or encrypted input on an unsupported host returns HTTP 400. Hosts/providers that supply no encrypted thinking produce no reasoning output. Duplicate IDs with identical state are emitted once; conflicting input state is rejected with HTTP 400. Conflicting provider output returns HTTP 502 before streaming, or a terminal `response.failed` event after streaming starts, with code `invalid_provider_reasoning`. Already emitted state is never silently replaced. Client-rewritten outer item IDs do not change the provider ID restored from the opaque envelope. The envelope adds no server-side storage and is not an authenticity signature; only the provider can validate its ciphertext. Reasoning diagnostics omit ciphertext and text; raw debug logging follows the existing logging policy. Keep replay on the same provider/model and account; encrypted state is not portable across arbitrary backends.

Known limitation: first-round search reasoning is used only for internal continuation with the private search tool call/results during synthesis. Historical `web_search_call` items are skipped on client replay and do not reconstruct that private exchange. Public history retains the final message and synthesis reasoning. A replay test covers the next client request; AM does not claim a byte-for-byte native hosted-search transcript.

## IDs and Codex Collaboration

AM generates response/message/output-item IDs such as `resp_AM-*`, `msg_AM-*`, `fc_AM-*`, `ctc_AM-*`, and `ws_AM-*`. Client-visible call IDs normally come from the model. History normalization may remap IDs only in the upstream request copy; outbound newly generated IDs remain unchanged.

For Codex Multi-Agent V2 collaboration message arguments, AM removes unsupported `encrypted` schema markers and returns `encrypted_function_args: []`. Codex can then deliver plaintext tasks instead of treating the text as encrypted. Use the [manual collaboration runbook](codex-multi-agent-e2e.md) when changing this behavior.

## Implementation and Verification

- [Route](../src/server/routes/openai/openaiResponsesRoutes.ts), [conversion/serialization](../src/server/utils/openaiResponses.ts), and [hosted-search validation](../src/server/utils/openaiResponsesWebSearch.ts).
- [Conversion tests](../src/test/server/openaiResponses.test.ts), [search tests](../src/test/server/openaiResponsesWebSearch.test.ts), and [official-SDK history tests](../src/test/server/toolHistoryRoutes.test.ts).
- [OpenAI upstream API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) describes the native API; it is not a promise that AM implements every feature.
