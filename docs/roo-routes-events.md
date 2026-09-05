# Roo HTTP and SSE Reference

Current AM contract, reviewed on 2026-09-05. This describes `/api/v1/roo` HTTP routes, not the Roo extension's in-process EventEmitter API. See [upstream API notes](roo-code/README.md) for that separate interface.

## Access and Endpoints

The default origin is `http://127.0.0.1:23333`. These routes require an active Roo-compatible extension. **The optional LLM API key does not authenticate `/api/v1/roo/*`.** Use authenticated network access before exposing the server remotely; see the [demo requirements](../examples/demo-site/README.md#remote-access).

| Method             | Path below `/api/v1`               | Purpose                                                             |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------- |
| POST               | `/roo/task`                        | Start a task and stream events                                      |
| POST               | `/roo/task/{taskId}/message`       | Send a message and stream events                                    |
| POST               | `/roo/task/{taskId}/action`        | `pressPrimaryButton`, `pressSecondaryButton`, `cancel`, or `resume` |
| GET                | `/roo/tasks`, `/roo/task/{taskId}` | Task history/detail                                                 |
| GET / PUT          | `/roo/settings`                    | Read/update settings                                                |
| GET                | `/roo/modes`                       | Available modes                                                     |
| GET / POST         | `/roo/profiles`                    | List/create profiles                                                |
| GET / PUT / DELETE | `/roo/profiles/{name}`             | Read/update/delete a profile                                        |
| PUT                | `/roo/profiles/active/{name}`      | Activate a profile                                                  |
| POST               | `/roo/install-mcp-config`          | Install AM MCP configuration                                        |

The running [`/openapi.json`](http://127.0.0.1:23333/openapi.json) is the reference for request fields and variant selection (`extensionId`). Task creation and message continuation accept `text` and optional `images`; only creation consumes `configuration` and `newTab`. Use the settings route for later configuration changes.

## Wire Format

Task creation and message requests return `text/event-stream`. Event names use `RooCodeEventName` camelCase values. Each `data` field is one JSON **object** defined by AM's [TaskEvent types](../src/server/types.ts), rather than an upstream positional argument array.

```text
event: message
data: {"taskId":"example-task","action":"updated","message":{"ts":1,"type":"say","say":"text","text":"Working","partial":true}}

```

| Event                                                                                         | Data                                                              |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `taskCreated`, `taskStarted`, `taskPaused`, `taskUnpaused`, `taskAskResponded`, `taskAborted` | `{taskId}`                                                        |
| `message`                                                                                     | `{taskId, action: "created" or "updated", message: ClineMessage}` |
| `taskModeSwitched`                                                                            | `{taskId, mode}`                                                  |
| `taskSpawned`                                                                                 | `{taskId, childTaskId}`                                           |
| `taskCompleted`                                                                               | `{taskId, tokenUsage, toolUsage}`                                 |
| `taskTokenUsageUpdated`                                                                       | `{taskId, tokenUsage}`                                            |
| `taskToolFailed`                                                                              | `{taskId, tool, error}`                                           |

An exception inside an open task/message stream can instead emit `taskAborted` with `{message: <error description>}`. Clients must allow that error shape. Failures before streaming use the route's JSON error response.

AM filters `message.say === "api_req_started"` and repeated identical complete messages. Other message content is passed through. Do not expect every event exposed by a newer Roo extension to be forwarded by AM; the table matches the registered adapter listeners.

## Completion and Stream Closure

`taskCompleted` supplies usage information but **does not close the stream**: completion text can arrive afterward. AM closes after forwarding one of these terminal events:

- A `message` with `partial` false/absent and `ask === "followup"`. The task is waiting for input, not necessarily finished.
- A `message` with `partial` false/absent and `say === "completion_result"`.
- `taskAborted`, or a stream-handler failure.

There is no separate `stream_closed` event. Do not wait an arbitrary number of seconds after `taskCompleted`; continue reading the stream and classify the terminal message. Transport EOF without a known terminal event can be a disconnect, not proof of success.

Old snake_case events (`task_created`, `task_completed`, `task_aborted`, `tool_failed`, `task_resumed`) and the old `error` / `stream_closed` events were removed in v2.0.1. The `message` name stayed unchanged.

## Task Flow

![Roo task and follow-up stream lifecycle](../assets/demo-workflow.png)

The diagram is generated from [demo-workflow.mmd](demo-workflow.mmd). It illustrates possible events; task content determines the exact sequence.

## Client Integration

Use a streaming POST client: browser `EventSource` alone cannot supply a POST request body. See the demo's [API reader](../examples/demo-site/src/app/roo/hooks/useApiClient.ts) for the repository's current integration.

Treat `message.text` as plain text unless the corresponding message type defines a JSON payload. Parse JSON defensively and preserve unknown messages for display. Tool approval must be associated with the intended task and structured operation; never classify a request as read-only by searching its free text for a tool name.

Implementation: [route forwarding](../src/server/routes/rooRoutes.ts), [adapter listeners and termination](../src/core/RooCodeAdapter.ts), [payload types](../src/server/types.ts).
