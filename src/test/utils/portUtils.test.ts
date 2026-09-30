import * as assert from "assert";
import * as http from "http";
import * as vscode from "vscode";

import { ExtensionController } from "../../core/controller";
import { ProxyServer } from "../../server/ProxyServer";
import { analyzePortUsage, isAgentMaestroService } from "../../utils/portUtils";

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return { server, port: (server.address() as { port: number }).port };
}
const close = (server: http.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

suite("Public service discovery", () => {
  test("discovers the proxy through health without requesting private info", async () => {
    const paths: string[] = [];
    const { server, port } = await listen((req, res) => {
      paths.push(req.url ?? "");
      if (req.url === "/health") {
        res.end(JSON.stringify({ name: "Agent Maestro", status: "ok" }));
      } else {
        res.writeHead(401);
        res.end();
      }
    });
    try {
      assert.strictEqual(await isAgentMaestroService(port), true);
      assert.deepStrictEqual(paths, ["/health"]);
    } finally {
      await close(server);
    }
  });

  test("recognizes older AM listeners and reports their policy limitation", async () => {
    const paths: string[] = [];
    const { server, port } = await listen((req, res) => {
      paths.push(req.url ?? "");
      assert.strictEqual(req.headers.authorization, undefined);
      if (req.url === "/health") {
        res.writeHead(404);
        res.end("Not found");
      } else {
        res.end(JSON.stringify({ name: "Agent Maestro", version: "2.14.0" }));
      }
    });
    try {
      const analysis = await analyzePortUsage(port);
      assert.strictEqual(analysis.action, "skip");
      assert.strictEqual(analysis.legacy, true);
      assert.match(
        analysis.message,
        /does not apply the new HTTP authentication policy/,
      );
      assert.deepStrictEqual(paths, ["/health", "/api/v1/info"]);
    } finally {
      await close(server);
    }
  });

  for (const status of [200, 401, 500]) {
    test(`does not probe legacy info when health returns ${status}`, async () => {
      const paths: string[] = [];
      const { server, port } = await listen((req, res) => {
        paths.push(req.url ?? "");
        res.writeHead(status);
        res.end("unexpected");
      });
      try {
        assert.strictEqual(await isAgentMaestroService(port), false);
        assert.deepStrictEqual(paths, ["/health"]);
      } finally {
        await close(server);
      }
    });
  }

  test("does not mistake unrelated legacy-shaped endpoints for AM", async () => {
    const { server, port } = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(404);
        res.end();
      } else {
        res.end(JSON.stringify({ name: "Other service" }));
      }
    });
    try {
      assert.strictEqual(
        (await analyzePortUsage(port)).action,
        "findAlternative",
      );
    } finally {
      await close(server);
    }
  });

  test("MCP discovery still uses only its health endpoint", async () => {
    const paths: string[] = [];
    const { server, port } = await listen((req, res) => {
      paths.push(req.url ?? "");
      res.end("Agent Maestro MCP Server is running");
    });
    try {
      assert.strictEqual(await isAgentMaestroService(port, "mcp"), true);
      assert.deepStrictEqual(paths, ["/health"]);
    } finally {
      await close(server);
    }
  });

  test("a new window monitors a legacy listener and takes over when it closes", async function () {
    this.timeout(10000);
    const { server, port } = await listen((req, res) => {
      if (req.url === "/health") {
        res.writeHead(404);
        res.end();
      } else {
        res.end(JSON.stringify({ name: "Agent Maestro" }));
      }
    });
    const proxy = new ProxyServer(
      { getExtensionStatus: () => ({}) } as unknown as ExtensionController,
      port,
      {
        secrets: { get: async () => undefined },
      } as unknown as vscode.ExtensionContext,
      {
        authorize: async () => "unavailable",
        getStatus: async () => "unavailable",
        configure: async () => {},
      },
    );
    const originalInterval = global.setInterval;
    const originalWarning = vscode.window.showWarningMessage;
    const warnings: string[] = [];
    let monitor: (() => Promise<void>) | undefined;
    global.setInterval = ((
      callback: () => Promise<void>,
      delay: number,
      ...args: unknown[]
    ) => {
      if (delay === 60000) {
        monitor = callback;
      }
      return originalInterval(callback, delay, ...args);
    }) as typeof setInterval;
    (vscode.window as any).showWarningMessage = async (message: string) => {
      warnings.push(message);
    };
    try {
      const result = await proxy.start();
      assert.strictEqual(result.started, false);
      assert.ok(monitor);
      assert.strictEqual(warnings.length, 1);
      await close(server);
      await monitor!();
      assert.strictEqual(proxy.getStatus().isRunning, true);
      assert.strictEqual(await isAgentMaestroService(port), true);
    } finally {
      global.setInterval = originalInterval;
      (vscode.window as any).showWarningMessage = originalWarning;
      await proxy.stop();
      if (server.listening) {
        await close(server);
      }
    }
  });
});
