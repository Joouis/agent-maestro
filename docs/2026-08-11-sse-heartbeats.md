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
| Gemini streamGenerateContent | SSE comment `: keep-alive`           |

SSE comments produce network traffic but are ignored by compliant parsers, so
they do not introduce non-JSON data events into OpenAI or Gemini streams.

The helper does not own a background interval and never calls `next()`
concurrently. Heartbeats and model chunks are therefore written in order.
Request timeout, client cancellation, and route error handling remain
authoritative and are not reset by heartbeats. Gemini's streaming route uses
the same request lifecycle as Anthropic and OpenAI so either condition also
cancels its VS Code LM request.

## Verification

Unit tests cover repeated heartbeats during a stalled `next()`, normal chunk
ordering, and timer cleanup. Route tests verify the Anthropic ping frame and the
OpenAI/Gemini comment frame.
