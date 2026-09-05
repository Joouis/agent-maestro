# Roo Tools and Message Payloads

Checked against [@roo-code/types 1.86.0](https://unpkg.com/@roo-code/types@1.86.0/dist/index.d.ts). Tool inventories and message formats are upstream contracts; AM forwards selected task events and exposes its own [HTTP/SSE contract](../roo-routes-events.md).

## Tools Versus API Methods

Tools such as `read_file`, `execute_command`, `use_mcp_tool`, and `access_mcp_resource` are operations available to Roo's agent. They are not methods on `RooCodeAPI`. In particular, the API does not expose `useMcpTool()` or `accessMcpResource()`.

Use Roo's task/message API to interact with a Roo task. An independent MCP client needs its own MCP connection; AM's task interface does not turn arbitrary upstream tool names into callable HTTP or extension methods.

For exact names, consult `toolNames`, `ToolName`, and `ToolGroup` in the package declarations. Tool availability also depends on the active mode, configuration, and extension version.

## Message Text

`ClineMessage.text` can be plain text, absent, or a JSON string. Use the message's `type` and `ask`/`say` discriminator before interpreting it. Common categories include:

| Message category                              | Interpretation                                                   |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `say: text`, `reasoning`, `completion_result` | Displayable text                                                 |
| `ask: followup`                               | Question and suggested-answer data; shape depends on Roo version |
| `ask: tool`                                   | Structured operation information                                 |
| `ask: use_mcp_server`                         | MCP server/tool/resource request information                     |
| `say: browser_action_result`                  | Browser result metadata, potentially including a screenshot      |
| `say: api_req_started`                        | API request metadata; filtered out of AM's HTTP SSE stream       |

Parse expected JSON inside `try/catch`, then validate the resulting object and relevant fields. A TypeScript assertion is not runtime validation. Preserve unfamiliar text for display rather than inventing a tool action. Do not use occurrence of a tool name inside text as an authorization decision.

The demo's [message handler](../../examples/demo-site/src/app/roo/hooks/useMessageHandler.ts) and [message types](../../examples/demo-site/src/app/roo/types/chat.ts) show the currently maintained UI integration.

## Usage and MCP

`ToolUsage` records attempts and failures by tool name. Treat it as reported telemetry, not proof that an external side effect did or did not occur.

AM's separate MCP server exposes Roo task orchestration with a configurable concurrency limit (default 5, maximum 20). See [McpServer.ts](../../src/server/McpServer.ts) and the **Agent Maestro: Install MCP Configuration** command. Protect the MCP endpoint separately when providing remote access.
