import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import type { IncomingMessage } from "http";
import * as vscode from "vscode";

import type { ExtensionController } from "../core/controller";
import { authorizeMcpRequest } from "../server/McpServer";
import { ProxyServer } from "../server/ProxyServer";
import {
  type ApiKeyState,
  type ApiKeys,
  checkAdminAccess,
  checkLlmAccess,
  createAnthropicAuthMiddleware,
  createGeminiAuthMiddleware,
  createOpenAIAuthMiddleware,
} from "../server/middleware/authMiddleware";
import { isOriginAllowed } from "../server/middleware/originMiddleware";
import { generateApiKey, validateAdminApiKey } from "../utils/apiKeys";
import { CONFIG_KEYS } from "../utils/config";

const LLM = "llm-key-0123456789";
const ADMIN = "admin-key-0123456789";

const unset: ApiKeyState = { status: "unset" };
const locked: ApiKeyState = { status: "locked" };
const set = (value: string): ApiKeyState => ({ status: "set", value });

const combos: Record<string, ApiKeys> = {
  none: { llm: unset, admin: unset },
  llmOnly: { llm: set(LLM), admin: unset },
  adminOnly: { llm: unset, admin: set(ADMIN) },
  both: { llm: set(LLM), admin: set(ADMIN) },
};

type Outcome = "ok" | 401 | 403 | 503;

function outcome(result: ReturnType<typeof checkAdminAccess>): Outcome {
  return result.ok ? "ok" : result.status;
}

/** Proxy instance whose keys and in-process Hono app are driven directly. */
function createProxy(secrets?: Partial<vscode.SecretStorage>) {
  const proxy = new ProxyServer({} as ExtensionController, 23333, {
    secrets,
  } as vscode.ExtensionContext);
  const app = (proxy as unknown as { app: OpenAPIHono }).app;
  return { proxy, app };
}

async function setCorsOrigins(origins: string[] | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(
      CONFIG_KEYS.PROXY_SERVER_CORS_ORIGINS,
      origins,
      vscode.ConfigurationTarget.Global,
    );
}

suite("API Authentication Test Suite", () => {
  suite("checkLlmAccess", () => {
    const cases: [string, (string | undefined)[], Outcome][] = [
      ["none", [], "ok"],
      ["none", ["anything"], "ok"],
      ["llmOnly", [LLM], "ok"],
      ["llmOnly", [ADMIN], 401],
      ["llmOnly", [], 401],
      ["adminOnly", [ADMIN], "ok"],
      ["adminOnly", [LLM], 401],
      ["both", [LLM], "ok"],
      ["both", [ADMIN], "ok"],
      ["both", ["wrong"], 401],
      ["both", [undefined], 401],
    ];
    for (const [combo, provided, expected] of cases) {
      test(`${combo} with ${JSON.stringify(provided)} -> ${expected}`, () => {
        assert.strictEqual(
          outcome(checkLlmAccess(combos[combo], provided)),
          expected,
        );
      });
    }

    test("distinguishes missing from invalid credentials", () => {
      const missing = checkLlmAccess(combos.llmOnly, [undefined]);
      const invalid = checkLlmAccess(combos.llmOnly, ["wrong"]);
      assert.ok(!missing.ok && missing.reason === "missing");
      assert.ok(!invalid.ok && invalid.reason === "invalid");
    });

    test("fails closed when either key is locked", () => {
      for (const keys of [
        { llm: locked, admin: unset },
        { llm: unset, admin: locked },
        { llm: set(LLM), admin: locked },
      ]) {
        assert.strictEqual(outcome(checkLlmAccess(keys, [LLM])), 503);
      }
    });
  });

  suite("checkAdminAccess", () => {
    const cases: [string, (string | undefined)[], Outcome][] = [
      ["none", [], "ok"],
      ["llmOnly", [LLM], 403],
      ["llmOnly", [], 403],
      ["adminOnly", [ADMIN], "ok"],
      ["adminOnly", [LLM], 401],
      ["adminOnly", [], 401],
      ["both", [ADMIN], "ok"],
      ["both", [LLM], 401],
      ["both", [undefined, ADMIN], "ok"],
      ["both", ["wrong", undefined], 401],
    ];
    for (const [combo, provided, expected] of cases) {
      test(`${combo} with ${JSON.stringify(provided)} -> ${expected}`, () => {
        assert.strictEqual(
          outcome(checkAdminAccess(combos[combo], provided)),
          expected,
        );
      });
    }

    test("fails closed when the Admin key is locked", () => {
      assert.strictEqual(
        outcome(checkAdminAccess({ llm: unset, admin: locked }, [ADMIN])),
        503,
      );
    });

    test("fails closed when only a locked LLM key could apply", () => {
      assert.strictEqual(
        outcome(checkAdminAccess({ llm: locked, admin: unset }, [])),
        503,
      );
    });

    test("a set Admin key still works when the LLM key is locked", () => {
      assert.strictEqual(
        outcome(checkAdminAccess({ llm: locked, admin: set(ADMIN) }, [ADMIN])),
        "ok",
      );
    });
  });

  suite("Proxy Server routes", () => {
    teardown(async () => {
      await setCorsOrigins(undefined);
    });

    // Empty handlers isolate the middleware; ProxyServer mounts the same
    // factories on these prefixes.
    const llmMiddlewares: [
      string,
      typeof createAnthropicAuthMiddleware,
      (key: string) => Record<string, string>,
    ][] = [
      [
        "Anthropic",
        createAnthropicAuthMiddleware,
        (key) => ({ "x-api-key": key }),
      ],
      [
        "OpenAI",
        createOpenAIAuthMiddleware,
        (key) => ({ authorization: `Bearer ${key}` }),
      ],
      [
        "Gemini",
        createGeminiAuthMiddleware,
        (key) => ({ "x-goog-api-key": key }),
      ],
    ];

    test("LLM routes accept either key in their native header", async () => {
      for (const [name, factory, header] of llmMiddlewares) {
        const app = new OpenAPIHono();
        app.use(
          "*",
          factory(() => combos.both),
        );
        app.post("/", (c) => c.text("ok"));
        const status = async (headers: Record<string, string>) =>
          (await app.request("/", { method: "POST", headers })).status;
        assert.strictEqual(await status(header(LLM)), 200, name);
        assert.strictEqual(await status(header(ADMIN)), 200, name);
        assert.strictEqual(await status(header("wrong")), 401, name);
        assert.strictEqual(await status({ "x-other": ADMIN }), 401, name);
      }
    });

    async function post(
      app: OpenAPIHono,
      route: string,
      headers: Record<string, string>,
    ) {
      return app.request(route, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    }

    test("control routes follow the rules table", async () => {
      const { proxy, app } = createProxy();
      const info = (headers: Record<string, string> = {}) =>
        app.request("/openapi.json", { headers });

      assert.strictEqual((await info()).status, 200);

      proxy.setLlmApiKey(LLM);
      const forbidden = await info({ authorization: `Bearer ${LLM}` });
      assert.strictEqual(forbidden.status, 403);
      assert.match((await forbidden.json()).message, /Admin API Key/);

      proxy.setAdminApiKey(ADMIN);
      assert.strictEqual((await info()).status, 401);
      assert.strictEqual(
        (await info({ authorization: `Bearer ${LLM}` })).status,
        401,
      );
      assert.strictEqual(
        (await info({ authorization: `Bearer ${ADMIN}` })).status,
        200,
      );
      assert.strictEqual((await info({ "x-api-key": ADMIN })).status, 200);
      assert.strictEqual(
        (await app.request("/api/v1/info", { headers: { "x-api-key": LLM } }))
          .status,
        401,
      );
    });

    test("/health is public even with both keys and a foreign origin", async () => {
      const { proxy, app } = createProxy();
      proxy.setLlmApiKey(LLM);
      proxy.setAdminApiKey(ADMIN);
      const response = await app.request("/health", {
        headers: { origin: "https://evil.example" },
      });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(await response.json(), { name: "Agent Maestro" });
    });

    test("a failed secret read locks routes instead of opening them", async () => {
      const { proxy, app } = createProxy({
        get: async () => {
          throw new Error("keychain unavailable");
        },
      });
      await proxy.restoreApiKeys();
      assert.strictEqual((await app.request("/openapi.json")).status, 503);
      assert.strictEqual(
        (await post(app, "/api/anthropic/v1/messages", { "x-api-key": "x" }))
          .status,
        503,
      );

      proxy.setAdminApiKey(ADMIN);
      proxy.setLlmApiKey(null);
      assert.strictEqual(
        (
          await app.request("/openapi.json", {
            headers: { "x-api-key": ADMIN },
          })
        ).status,
        200,
      );
    });

    test("restores both keys from secret storage", async () => {
      const stored: Record<string, string> = {
        "agent-maestro.llmApiKey": LLM,
        "agent-maestro.adminApiKey": ADMIN,
      };
      const { proxy } = createProxy({ get: async (key) => stored[key] });
      let changes = 0;
      proxy.onApiKeysChanged(() => changes++);
      await proxy.restoreApiKeys();
      assert.deepStrictEqual(proxy.getApiKeys(), combos.both);
      assert.strictEqual(changes, 1);
      await proxy.restoreApiKeys();
      assert.strictEqual(changes, 1, "an unchanged restore notifies nobody");
    });

    /** Secret reads that stay pending until the test resolves them. */
    function controlledSecrets() {
      const reads: { key: string; resolve: (value?: string) => void }[] = [];
      const get = (key: string) =>
        new Promise<string | undefined>((resolve) =>
          reads.push({ key, resolve }),
        );
      const answer = (batch: number, values: Record<string, string>) => {
        for (const read of reads.slice(batch * 2, batch * 2 + 2)) {
          read.resolve(values[read.key]);
        }
      };
      return { get, answer };
    }

    test("a slower, older restore cannot overwrite a newer one", async () => {
      const secrets = controlledSecrets();
      const { proxy } = createProxy({ get: secrets.get });
      const revoked = "revoked-admin-key-0001";

      const older = proxy.restoreApiKeys();
      const newer = proxy.restoreApiKeys();
      // The newer read sees the revocation and finishes first; the older read
      // still holds the revoked key and finishes last.
      secrets.answer(1, {});
      secrets.answer(0, { "agent-maestro.adminApiKey": revoked });
      await Promise.all([older, newer]);

      assert.deepStrictEqual(proxy.getApiKeys(), combos.none);
    });

    test("a restore in flight cannot overwrite a key set locally", async () => {
      const secrets = controlledSecrets();
      const { proxy } = createProxy({ get: secrets.get });

      const restore = proxy.restoreApiKeys();
      proxy.setAdminApiKey(ADMIN);
      secrets.answer(0, {});
      await restore;

      assert.deepStrictEqual(proxy.getApiKeys(), combos.adminOnly);
    });

    test("an awaited restore waits for restores started after it", async () => {
      const secrets = controlledSecrets();
      const { proxy } = createProxy({ get: secrets.get });

      let firstSettled = false;
      const first = proxy.restoreApiKeys().then(() => (firstSettled = true));
      secrets.answer(0, {});
      const second = proxy.restoreApiKeys();
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(firstSettled, false, "must not start on stale state");

      secrets.answer(1, { "agent-maestro.adminApiKey": ADMIN });
      await Promise.all([first, second]);
      assert.deepStrictEqual(proxy.getApiKeys(), combos.adminOnly);
    });

    test("rejects disallowed origins before the handler runs", async () => {
      const { app } = createProxy();
      // A text/plain POST skips the browser preflight; it must not execute.
      const response = await app.request("/api/v1/fs/write", {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "text/plain",
        },
        body: JSON.stringify({ path: "pwned.txt", content: "x" }),
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual(
        response.headers.get("access-control-allow-origin"),
        null,
      );

      const noOrigin = await app.request("/openapi.json");
      assert.strictEqual(noOrigin.status, 200);
    });

    test("allowlisted origins get CORS headers and preflight", async () => {
      const { app } = createProxy();
      await setCorsOrigins(["http://localhost:5173"]);

      const response = await app.request("/openapi.json", {
        headers: { origin: "http://localhost:5173" },
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        response.headers.get("access-control-allow-origin"),
        "http://localhost:5173",
      );
      assert.match(response.headers.get("vary") ?? "", /Origin/);
      assert.strictEqual(
        response.headers.get("access-control-allow-credentials"),
        null,
      );

      const preflight = await app.request("/api/v1/fs/write", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,content-type",
        },
      });
      assert.strictEqual(preflight.status, 204);
      assert.match(
        preflight.headers.get("access-control-allow-headers") ?? "",
        /Authorization/,
      );

      const other = await app.request("/openapi.json", {
        headers: { origin: "http://localhost:3000" },
      });
      assert.strictEqual(other.status, 403);
    });

    test("wildcard allows any origin and changes apply without restart", async () => {
      const { app } = createProxy();
      const request = () =>
        app.request("/openapi.json", {
          headers: { origin: "https://anything.example" },
        });
      assert.strictEqual((await request()).status, 403);
      await setCorsOrigins(["*"]);
      assert.strictEqual((await request()).status, 200);
    });
  });

  suite("isOriginAllowed", () => {
    test("matches exact origins only", () => {
      assert.strictEqual(
        isOriginAllowed("http://localhost:5173", ["http://localhost:5173"]),
        true,
      );
      assert.strictEqual(
        isOriginAllowed("http://localhost:5173", ["localhost"]),
        false,
      );
      assert.strictEqual(
        isOriginAllowed("http://localhost:5173", ["http://localhost"]),
        false,
      );
      assert.strictEqual(isOriginAllowed("https://x.example", ["*"]), true);
      assert.strictEqual(isOriginAllowed("https://x.example", []), false);
    });
  });

  suite("authorizeMcpRequest", () => {
    const request = (headers: Record<string, string>) =>
      ({ headers }) as unknown as IncomingMessage;

    function statusOf(fn: () => void): number | "ok" {
      try {
        fn();
        return "ok";
      } catch (error) {
        assert.ok(error instanceof Response);
        return error.status;
      }
    }

    test("allows clients without Origin when no keys are set", () => {
      assert.strictEqual(
        statusOf(() => authorizeMcpRequest(request({}), combos.none, [])),
        "ok",
      );
    });

    test("rejects disallowed origins even without keys", () => {
      assert.strictEqual(
        statusOf(() =>
          authorizeMcpRequest(
            request({ origin: "https://evil.example" }),
            combos.none,
            [],
          ),
        ),
        403,
      );
      assert.strictEqual(
        statusOf(() =>
          authorizeMcpRequest(
            request({ origin: "https://ok.example" }),
            combos.none,
            ["https://ok.example"],
          ),
        ),
        "ok",
      );
    });

    test("applies the Admin rules with either header", () => {
      assert.strictEqual(
        statusOf(() => authorizeMcpRequest(request({}), combos.llmOnly, [])),
        403,
      );
      assert.strictEqual(
        statusOf(() => authorizeMcpRequest(request({}), combos.both, [])),
        401,
      );
      assert.strictEqual(
        statusOf(() =>
          authorizeMcpRequest(
            request({ authorization: `Bearer ${ADMIN}` }),
            combos.both,
            [],
          ),
        ),
        "ok",
      );
      assert.strictEqual(
        statusOf(() =>
          authorizeMcpRequest(request({ "x-api-key": ADMIN }), combos.both, []),
        ),
        "ok",
      );
      assert.strictEqual(
        statusOf(() =>
          authorizeMcpRequest(request({ "x-api-key": LLM }), combos.both, []),
        ),
        401,
      );
    });
  });

  suite("Admin API key helpers", () => {
    test("generated keys use the am_ base64url format", () => {
      const keys = new Set(Array.from({ length: 20 }, generateApiKey));
      assert.strictEqual(keys.size, 20);
      for (const key of keys) {
        assert.match(key, /^am_[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(validateAdminApiKey(key), undefined);
      }
    });

    test("manual keys need 16+ characters and no whitespace", () => {
      assert.strictEqual(validateAdminApiKey("a".repeat(16)), undefined);
      assert.ok(validateAdminApiKey("a".repeat(15)));
      assert.ok(validateAdminApiKey("a".repeat(16) + " "));
      assert.ok(validateAdminApiKey("abcdefgh\tijklmnop"));
    });
  });
});
