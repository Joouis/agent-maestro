---
"agent-maestro": minor
---

Inject VS Code LM MCP tools into Anthropic /v1/messages requests — enables Claude Code to transparently use any MCP server configured in VS Code (e.g. Linear, GitHub, Sentry) without additional setup. Adds agentic loop for both streaming and non-streaming paths with max 10 rounds, executing MCP tool calls via `vscode.lm.invokeTool()` while passing non-MCP tool calls through to the client as before.
