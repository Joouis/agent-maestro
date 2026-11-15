---
"agent-maestro": minor
---

Add an optional Admin API Key that protects `/api/v1`, `/openapi.json`, and the MCP server, and reject browser requests from origins not listed in the new `agent-maestro.proxyServerCorsOrigins` / `agent-maestro.mcpServerCorsOrigins` settings. **Breaking:** with only the LLM API Key set, `/api/v1` and MCP now return 403 until an Admin API Key is set; browser apps on other origins (including the Roo demo site) must be added to the origin settings; a stored key that cannot be read now returns 503 instead of disabling authentication. Adds a public `GET /health` endpoint.
