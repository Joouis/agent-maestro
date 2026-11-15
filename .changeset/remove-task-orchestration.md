---
"agent-maestro": major
---

Remove third-party extension task orchestration and the MCP task server. Agent Maestro now focuses on the model API proxy; use the Cline or Kilo Code CLIs to drive those agents from scripts.

**Removed:**

- Routes: all `/api/v1/roo/*` task, message, action, profile, settings, mode, and MCP-config routes, and `POST /api/v1/cline/task`.
- The MCP server (default port `23334`) and its **Execute Roo Tasks** tool.
- Commands: **Start MCP Server**, **Stop MCP Server**, **Get MCP Server Status**, **Install MCP Configuration**, and **Get Extensions Status**.
- Settings: `agent-maestro.mcpServerPort`, `agent-maestro.mcpServerCorsOrigins`, `agent-maestro.rooVariantIdentifiers`, and `agent-maestro.defaultRooIdentifier`, plus the `AGENT_MAESTRO_MCP_PORT` environment variable.
- The `extensions` field from the `GET /api/v1/info` response.
- The Roo task demo site.

Agent Maestro no longer activates Roo Code, Cline, or Kilo Code. If you previously ran **Install MCP Configuration**, remove the "Agent Maestro" entry (`http://localhost:23334/mcp`) from the MCP settings of Roo Code or Kilo Code.

The LLM proxy, client configurators, Exa search, file, workspace, and model-discovery routes, the Admin and LLM API keys, and the origin policy are unchanged.
