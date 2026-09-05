# Roo Extension Events

This page covers Roo's in-process EventEmitter API, checked against [types 1.86.0](https://unpkg.com/@roo-code/types@1.86.0/dist/index.d.ts). **For AM SSE event names, JSON payloads, filtering, and closure rules use the [HTTP/SSE reference](../roo-routes-events.md).**

## Common Events

| Event                                       | Upstream listener arguments                                   |
| ------------------------------------------- | ------------------------------------------------------------- |
| `message`                                   | One object containing `taskId`, `action`, and `message`       |
| `taskCreated`, `taskStarted`, `taskAborted` | `taskId`                                                      |
| `taskModeSwitched`                          | `taskId`, `mode`                                              |
| `taskSpawned`                               | Parent task ID, child task ID                                 |
| `taskCompleted`                             | `taskId`, `tokenUsage`, `toolUsage`, `{ isSubtask: boolean }` |
| `taskTokenUsageUpdated`                     | `taskId`, `tokenUsage`                                        |
| `taskToolFailed`                            | `taskId`, tool name, error                                    |

This is a subset, not a complete enum. Consult `RooCodeEventName` and `RooCodeAPIEvents` in the versioned declarations for all upstream events. AM forwards only listeners registered in its [adapter](../../src/core/RooCodeAdapter.ts).

AM's HTTP `taskCompleted` payload includes the task ID and usage fields but currently omits the upstream `isSubtask` metadata.

## Message Updates

`ClineMessage` identifies an `ask` or `say` message, with a timestamp, optional text/images, and a `partial` indicator. The action is `created` or `updated`; a partial update is not a second completed message. The format of `message.text` depends on its ask/say type. See [message parsing](roo-api-tools.md#message-text).

Task completion notification and final completion text can arrive separately. Never assume the upstream `taskCompleted` notification alone means that AM's SSE stream has ended.

## Integration Rules

- Register listeners before starting work; filter events by task ID.
- Remove listeners when the intended operation ends, including timeout/error paths.
- Do not automatically approve a tool by matching a substring in free-form message text. Verify the structured operation and intended task first.
- Current-task methods such as `pressPrimaryButton` and `sendMessage` are not addressed to the task ID in an event. Avoid cross-task actions when other tasks can become active.

For a maintained consumer, inspect the demo's [message handler](../../examples/demo-site/src/app/roo/hooks/useMessageHandler.ts) together with the AM wire contract.
