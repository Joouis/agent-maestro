import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import { mkdtemp, rm } from "fs/promises";
import { cors } from "hono/cors";
import { tmpdir } from "os";
import { join } from "path";
import * as vscode from "vscode";

import { ExtensionController } from "../core/controller";
import { ProxyServer } from "../server/ProxyServer";
import { FileHttpAuthentication } from "../server/httpAuthentication";
import {
  ApiProtocol,
  createApiAuthMiddleware,
} from "../server/middleware/authMiddleware";

suite("HTTP API authentication boundary", () => {
  let directory: string;
  let authentication: FileHttpAuthentication;
  setup(async () => {
    directory = await mkdtemp(join(tmpdir(), "am-route-auth-"));
    authentication = new FileHttpAuthentication(join(directory, "auth.json"));
  });
  teardown(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const protocols: Array<[ApiProtocol, string]> = [
    ["control", "Authorization"],
    ["openai", "Authorization"],
    ["anthropic", "x-api-key"],
    ["gemini", "x-goog-api-key"],
  ];
  for (const [protocol, header] of protocols) {
    test(`${protocol}: setup, key validation, and disabled policy`, async () => {
      const app = new OpenAPIHono();
      app.use(cors());
      app.use("/protected", createApiAuthMiddleware(authentication, protocol));
      app.post("/protected", (c) => c.json({ ok: true }));
      let response = await app.request("/protected", { method: "POST" });
      assert.strictEqual(response.status, 503);
      const error = await response.json();
      if (protocol === "gemini") {
        assert.strictEqual(error.error.status, "UNAVAILABLE");
      }
      if (protocol === "anthropic") {
        assert.strictEqual(error.type, "error");
      }
      await authentication.configure("test-key");
      for (const key of [undefined, "wrong-key", "x".repeat(1025)]) {
        response = await app.request("/protected", {
          method: "POST",
          headers: key
            ? { [header]: header === "Authorization" ? `Bearer ${key}` : key }
            : {},
        });
        assert.strictEqual(response.status, 401);
        if (protocol === "control") {
          assert.ok(response.headers.get("www-authenticate"));
        }
      }
      response = await app.request("/protected", {
        method: "POST",
        headers: {
          [header]: header === "Authorization" ? "bearer test-key" : "test-key",
        },
      });
      assert.strictEqual(response.status, 200);
      const preflight = await app.request("/protected", {
        method: "OPTIONS",
        headers: {
          Origin: "https://client.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": header,
        },
      });
      assert.strictEqual(preflight.status, 204);
      await authentication.configure(null);
      assert.strictEqual(
        (await app.request("/protected", { method: "POST" })).status,
        200,
      );
    });
  }

  test("overload returns Retry-After without directing users to reset authentication", async () => {
    for (const [protocol] of protocols) {
      const app = new OpenAPIHono();
      app.use(
        "*",
        createApiAuthMiddleware({ authorize: async () => "busy" }, protocol),
      );
      app.get("/", (c) => c.json({ ok: true }));
      const response = await app.request("/");
      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.headers.get("Retry-After"), "1");
      const body = await response.text();
      assert.match(body, /busy/);
      assert.ok(!body.includes("Set API Key"));
    }
  });

  test("all registered API handlers require authentication while discovery stays public", async () => {
    const proxy = new ProxyServer(
      { getExtensionStatus: () => ({}) } as unknown as ExtensionController,
      0,
      {
        secrets: { get: async () => undefined },
      } as unknown as vscode.ExtensionContext,
      authentication,
    );
    const app = (proxy as unknown as { app: OpenAPIHono }).app;
    const routes = [
      ...new Map(
        app.routes
          .filter((r) => r.path.startsWith("/api/") && r.method !== "ALL")
          .map((r) => [r.method + r.path, r]),
      ).values(),
    ];
    assert.ok(routes.length >= 30);
    for (const r of routes) {
      assert.strictEqual(
        (
          await app.request(r.path.replace(/:[^/]+/g, "test"), {
            method: r.method,
          })
        ).status,
        503,
        r.path,
      );
    }
    assert.deepStrictEqual(await (await app.request("/health")).json(), {
      name: "Agent Maestro",
      status: "ok",
    });
    assert.strictEqual((await app.request("/openapi.json")).status, 200);
    await authentication.configure("test-key");
    for (const r of routes) {
      assert.strictEqual(
        (
          await app.request(r.path.replace(/:[^/]+/g, "test"), {
            method: r.method,
          })
        ).status,
        401,
        r.path,
      );
    }
    assert.strictEqual(
      (
        await app.request("/api/v1/info", {
          headers: { Authorization: "Bearer test-key" },
        })
      ).status,
      200,
    );
    const spec = await (await app.request("/openapi.json")).json();
    assert.deepStrictEqual(spec.paths["/api/v1/info"].get.security, [
      { bearerAuth: [] },
    ]);
    assert.ok(spec.paths["/api/v1/info"].get.responses["503"]);
    assert.strictEqual(spec.paths["/health"].get.security, undefined);
  });
});
