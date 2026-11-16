import * as assert from "assert";
import * as http from "http";
import type { AddressInfo } from "net";

import { detectAgentMaestroService } from "../../utils/portUtils";

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

suite("detectAgentMaestroService", () => {
  const cases: [
    string,
    Record<string, { status: number; body: string }>,
    "current" | "legacy" | undefined,
  ][] = [
    [
      "current proxy via /health",
      { "/health": { status: 200, body: AM_INFO } },
      "current",
    ],
    [
      "legacy proxy without /health is detected via /api/v1/info",
      { "/api/v1/info": { status: 200, body: AM_INFO } },
      "legacy",
    ],
    [
      "no fallback when /health answers with another app",
      {
        "/health": { status: 200, body: "ok" },
        "/api/v1/info": { status: 200, body: AM_INFO },
      },
      undefined,
    ],
    ["unrelated app with neither route", {}, undefined],
  ];

  for (const [name, routes, expected] of cases) {
    test(name, async () => {
      const server = await serve(routes);
      try {
        assert.strictEqual(
          await detectAgentMaestroService(server.port),
          expected,
        );
      } finally {
        await server.close();
      }
    });
  }
});
