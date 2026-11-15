import * as assert from "assert";
import * as http from "http";
import type { AddressInfo } from "net";

import { isAgentMaestroService } from "../../utils/portUtils";

/** Serves fixed responses by path and returns the bound port. */
async function serve(
  routes: Record<string, { status: number; body: string }>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const route = routes[req.url ?? ""] ?? { status: 404, body: "" };
    res.writeHead(route.status).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const AM_INFO = JSON.stringify({ name: "Agent Maestro" });

suite("isAgentMaestroService", () => {
  const cases: [
    string,
    Record<string, { status: number; body: string }>,
    "proxy" | "mcp",
    boolean,
  ][] = [
    [
      "current proxy via /health",
      { "/health": { status: 200, body: AM_INFO } },
      "proxy",
      true,
    ],
    [
      "legacy proxy without /health falls back to /api/v1/info",
      { "/api/v1/info": { status: 200, body: AM_INFO } },
      "proxy",
      true,
    ],
    [
      "no fallback when /health answers with another app",
      {
        "/health": { status: 200, body: "ok" },
        "/api/v1/info": { status: 200, body: AM_INFO },
      },
      "proxy",
      false,
    ],
    ["unrelated app with neither route", {}, "proxy", false],
    [
      "MCP server via /health",
      {
        "/health": { status: 200, body: "Agent Maestro MCP Server is running" },
      },
      "mcp",
      true,
    ],
    [
      "MCP never falls back to /api/v1/info",
      { "/api/v1/info": { status: 200, body: AM_INFO } },
      "mcp",
      false,
    ],
  ];

  for (const [name, routes, serviceType, expected] of cases) {
    test(name, async () => {
      const server = await serve(routes);
      try {
        assert.strictEqual(
          await isAgentMaestroService(server.port, serviceType),
          expected,
        );
      } finally {
        await server.close();
      }
    });
  }
});
