---
"agent-maestro": minor
---

Add opt-in execution of Anthropic's `web_search` server-side tool. When enabled, the proxy intercepts `web_search_20250305` tool calls from clients (e.g. Claude Code's WebSearch), runs the query against a third-party search API (Tavily by default, Brave optional), and synthesizes the `server_tool_use` + `web_search_tool_result` blocks Anthropic's backend would have returned. Multi-turn loop honors `max_uses` and respects `allowed_domains` / `blocked_domains`. Disabled by default — when off, web_search tool definitions are silently dropped (existing behavior from #167).

New settings: `agent-maestro.webSearch.enabled`, `.provider`, `.apiKey`, `.maxResults`, `.maxUsesPerRequest`, `.timeoutMs`. API key may also be supplied via `AGENT_MAESTRO_WEBSEARCH_API_KEY`.
