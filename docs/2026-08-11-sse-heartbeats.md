# SSE heartbeats

## Problem

Streaming routes establish an SSE response before VS Code LM produces its first
chunk. With large contexts or concurrent requests, that wait can be long enough
for clients such as Claude Code to treat the otherwise healthy connection as
idle and retry ([#227](https://github.com/Joouis/agent-maestro/issues/227)).

The existing request timeout solves a different problem: it cancels an upstream
request that exceeds its total lifetime. A heartbeat keeps the downstream
connection active while that request is still within the allowed lifetime.

## Design

Wrap the upstream async iterable with a small `withSseHeartbeat()` helper. While
one `iterator.next()` is pending, the helper yields a heartbeat marker every 10
seconds. Routes handle that marker using their protocol's wire format:

| Route                        | Heartbeat frame                      |
| ---------------------------- | ------------------------------------ |
| Anthropic Messages           | `event: ping` with `{"type":"ping"}` |
| OpenAI Chat/Responses        | SSE comment `: keep-alive`           |
| Gemini streamGenerateContent | Blank line `\n`                      |

OpenAI streams use SSE comments, which produce network traffic without
introducing data events. The Google Gen AI SDK parser stalls on comment frames
and reports `Incomplete JSON segment at the end`. Gemini therefore sends blank
lines, which the SDK accepts as whitespace before the next `data:` frame. Unlike
`data: {}`, blank lines do not yield extra response chunks or trigger additional
per-chunk processing such as Gemini CLI `AfterModel` hooks.

The helper does not own a background interval and never calls `next()`
concurrently. Heartbeats and model chunks are therefore written in order.
Request timeout, client cancellation, and route error handling remain
authoritative and are not reset by heartbeats. Gemini's streaming route uses
the same request lifecycle as Anthropic and OpenAI so either condition also
cancels its VS Code LM request.

## Verification

Unit tests cover repeated heartbeats during a stalled `next()`, normal chunk
ordering, and timer cleanup. Route tests verify the Anthropic ping frame and the
OpenAI comment frame. Gemini tests verify that an HTTP client receives blank-line
heartbeats before the model responds and that the real Google Gen AI SDK ignores
those heartbeats while preserving text, tool calls, completion status, and token
usage. Timeout and client-disconnect tests verify upstream cancellation.
