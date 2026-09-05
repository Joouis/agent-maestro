# Gemini Routes: Historical Design

## Status

Original proposal dated 2025-11-15; generation endpoints shipped in v2.4.0. This condensed record was reviewed on 2026-09-05. The old pseudocode is historical and is available in [repository history](https://github.com/Joouis/agent-maestro/blob/ad8f5420533109d6282d0f4549debe0be78536d1/docs/2025-11-15-gemini-routes-design.md).

For the implemented endpoint contract and examples, use [LLM compatibility](llm-compatibility.md). Do not copy the original counting/stream helpers into current code.

## Original Decisions

- Expose `generateContent`, `streamGenerateContent`, and `countTokens` below `/api/gemini/v1beta/models/{model}`.
- Translate Gemini `Content` / `Part` objects into VS Code LM text, tool-call, tool-result, and supported data parts. Map `model` to assistant and ordinary user content to user; convert `systemInstruction` separately.
- Resolve requested model IDs through AM's model-selection helper rather than implement provider-specific model-name rewriting.
- Keep route orchestration, protocol conversion, and schemas separate in `geminiRoutes.ts`, `utils/gemini.ts`, and `schemas/gemini.ts`. Register them in `src/server/ProxyServer.ts`.
- Use Gemini-style SSE data frames and error envelopes. Accept evolving request bodies without claiming all Gemini options are supported.
- Defer embedding and provider-managed cached-content endpoints.

## Changes Since the Proposal

| Original idea                                             | Implemented behavior                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share a preparation helper that counts converted messages | `countTokens` estimates `JSON.stringify(requestBody)`; generation prepares messages separately.                                                         |
| Incremental local usage counting                          | Prefer Copilot usage metadata when available; count locally as fallback.                                                                                |
| Cached-content counting                                   | AM does not resolve provider caches; requested cached-token count metadata is zero.                                                                     |
| Direct call/result conversion                             | [History normalization](2026-09-04-tool-history-normalization-design.md) handles missing IDs, replays, and conflicts across complete inbound snapshots. |
| Basic streaming                                           | [Blank-line heartbeats](2026-08-11-sse-heartbeats.md) preserve SDK parsing; streaming has cancellation and a request deadline.                          |

## Sources and Verification

- [Routes](../src/server/routes/geminiRoutes.ts), [conversion](../src/server/utils/gemini.ts), and [schemas](../src/server/schemas/gemini.ts).
- [Conversion tests](../src/test/server/gemini.test.ts) and [heartbeat/SDK tests](../src/test/server/sseHeartbeat.test.ts).
- [Upstream Gemini API](https://ai.google.dev/api) describes native capabilities, not AM's supported subset.
