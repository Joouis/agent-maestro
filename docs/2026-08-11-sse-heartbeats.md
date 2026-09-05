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

Anthropic, Chat Completions, and Gemini wrap the upstream async iterable with
`withSseHeartbeat()`. While one `iterator.next()` is pending, it yields a heartbeat
marker every 10 seconds. Responses wraps its streaming operation with
`withOpenAIResponsesHeartbeat()` to track time since the last downstream write.
Each route uses its protocol's wire format:

| Route                        | Heartbeat frame                      |
| ---------------------------- | ------------------------------------ |
| Anthropic Messages           | `event: ping` with `{"type":"ping"}` |
| OpenAI Chat                  | SSE comment `: keep-alive`           |
| OpenAI Responses             | `keepalive` JSON event               |
| Gemini streamGenerateContent | Blank line `\n`                      |

SSE comments produce network traffic but are ignored by compliant parsers, so
they do not introduce data events into Chat Completions streams.
Codex measures idle time between parsed SSE events, so comments do not reset its
idle timer. Responses uses JSON `keepalive` events with increasing sequence
numbers instead. These events carry no response snapshot. Repeating
`response.in_progress` with an empty output would replace the OpenAI SDK's
accumulated response and break subsequent indexed events.

The Google Gen AI SDK parser stalls on comment frames
and reports `Incomplete JSON segment at the end`. Gemini therefore sends blank
lines, which the SDK accepts as whitespace before the next `data:` frame. Unlike
`data: {}`, blank lines do not yield extra response chunks or trigger additional
per-chunk processing such as Gemini CLI `AfterModel` hooks.

Responses heartbeats track downstream writes independently of upstream chunks.
They cover model startup, ignored model data, the buffered search loop, and final
token counting. The heartbeat timer is stopped and any pending heartbeat write
is settled before emitting a terminal event, including on failure or cancellation.

Neither helper owns a background interval. The iterable helper never calls
`next()` concurrently; the Responses helper writes complete SSE events in
sequence alongside the operation and awaits heartbeat writes before returning.
Responses writers accept only string data. Callers assign sequence numbers and
serialize JSON before writing, so deferred data cannot reorder frames before
they reach Hono's shared `WritableStream` writer. That writer queues complete
frames in order even when a slow consumer applies backpressure.
Request timeout, client cancellation, and route error handling remain
authoritative and are not reset by heartbeats. Gemini's streaming route uses
the same request lifecycle as Anthropic and OpenAI so either condition also
cancels its VS Code LM request.

## Verification

Unit tests cover repeated heartbeats during a stalled `next()`, normal chunk
ordering, and timer cleanup. Route tests verify Anthropic ping events,
Chat Completions comments, and Responses JSON heartbeats during model
startup, ignored chunks, search, and token counting, plus terminal event ordering
and cancellation. Tests also consume route streams through the official OpenAI
SDK's `responses.stream()` accumulator, checking that heartbeats preserve text
and web-search output items before subsequent deltas or completion events.
Slow-reader tests use Hono's streaming API to block either an operation write
or a heartbeat first, then verify overlapping writes preserve complete frames,
consecutive sequence numbers, and a final terminal event with no later heartbeat.

Gemini tests verify that an HTTP client receives blank-line
heartbeats before the model responds and that the real Google Gen AI SDK ignores
those heartbeats while preserving text, tool calls, completion status, and token
usage. Timeout and client-disconnect tests verify upstream cancellation.
