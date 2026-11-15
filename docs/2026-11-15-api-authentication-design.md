# API Authentication and Origin Policy, 2026-11-15

> **Status:** Implemented; see [README access and authentication](../README.md#access-and-authentication). Baseline: `fe46d2a` (v2.16.0). Dependency behavior verified against the locked versions `hono@4.8.9`, `@hono/zod-openapi@1.0.2`, `fastmcp@3.5.0`, `mcp-proxy@5.1.1`.

## Problem

Agent Maestro (AM) runs two HTTP servers. Both listen on all interfaces:

- Proxy Server, default port `23333`.
- MCP Server, default port `23334`.

Only the LLM-compatible routes (`/api/anthropic/*`, `/api/openai/*`, `/api/gemini/*`) can require a key, and only after the user runs **Set LLM API Key**. Every other surface is unauthenticated, even when that key is set:

| Surface                                                        | Impact if reachable                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `/api/v1/fs/read`, `/api/v1/fs/write`                          | Read and write any file in the workspace                        |
| `/api/v1/roo/*`, `/api/v1/cline/task`, MCP `Execute Roo Tasks` | Run agent tasks, which can execute commands                     |
| `/api/v1/roo/settings`, `/api/v1/roo/profiles`                 | Read third-party provider API keys; redirect provider base URLs |
| `/api/v1/workspace/*`                                          | Change or close workspace folders                               |
| `/api/v1/info`, `/api/v1/lm/*`, `/openapi.json`                | Information disclosure                                          |

Two exposure paths matter:

1. **Remote access.** A user exposes AM through a VS Code port forward (dev tunnel), a VM, or the LAN. Anyone who can reach the port controls the workspace.
2. **Browser attacks on a local AM.** Any web page the user opens can reach `127.0.0.1`. Verified current behavior:
   - The Proxy Server uses `cors()` with no options and allows every origin, so a page can call any route and read the response.
   - Even with CORS tightened, a page can send a "simple" request (`POST` with `Content-Type: text/plain`) without a preflight. Most `/api/v1` handlers call `c.req.json()` directly without checking the content type, and `@hono/zod-openapi` skips validation for non-JSON content types on optional bodies. The write still executes; the page just cannot read the response.
   - mcp-proxy, the MCP Server's HTTP layer, reflects any `Origin` with `Access-Control-Allow-Credentials: true`. FastMCP 3.5 offers no option to change this, so any page can open a full MCP session.

## Goals

- Optionally protect every Proxy Server route and the MCP Server with a key.
- Separate inference-only access from control of the workspace.
- Keep the local zero-configuration experience for non-browser clients.
- Block browser requests from origins the user has not allowed, on both servers.

## Non-goals

- **TLS inside AM.** VS Code port forwarding terminates TLS at the tunnel edge. Set the Ports-panel protocol to **HTTP**, because AM serves plain HTTP locally.
- **A bind-host setting.** Exposing AM beyond the machine is the user's deliberate choice.
- **Hardening the no-key mode.** AM is a developer tool. Without keys, AM trusts everything that can reach it. Users who expose AM must set keys. The origin policy below is the only exception, because it is cheap and stops drive-by web pages.
- **Deciding access by request source or `Host`.** Port-forwarded traffic arrives from `127.0.0.1`, and clients control `Host`. Authentication depends only on which keys are configured.
- Per-route scopes, multiple keys per tier, rate limiting.

### Accepted residual risks

- **No keys set:** LAN peers can use the Copilot quota and every control route. DNS rebinding can make a malicious page same-origin with AM and bypass the origin policy.
- **`*` in an origin list without keys:** restores today's browser exposure. AM logs a warning (see [Origin policy](#origin-policy)).

## Design

### Keys

| Key           | Command                                                  | Secret storage key          | Grants          |
| ------------- | -------------------------------------------------------- | --------------------------- | --------------- |
| LLM API Key   | `agent-maestro.setLlmApiKey` (existing)                  | `agent-maestro.llmApiKey`   | LLM routes only |
| Admin API Key | `agent-maestro.setAdminApiKey` "Set Admin API Key" (new) | `agent-maestro.adminApiKey` | Everything      |

Both keys are compared in constant time with the existing `constantTimeEqual`. Key changes take effect on the Proxy Server immediately; see [MCP Server](#mcp-server) for sessions.

#### Set Admin API Key command

A QuickPick offers:

1. **Generate a random key.** The format is `am_` followed by 32 random bytes from `crypto.randomBytes` encoded as base64url, for 46 characters total. The prefix makes keys recognizable in logs and secret scanners. AM copies the key to the clipboard and shows a notification with a **Copy** button to copy it again. The key is not shown again after the notification closes. A lost key must be regenerated.
2. **Enter a key manually.** The input is a password box. Validation requires at least 16 characters and no whitespace.
3. **Clear the key.** This option is shown only when a key is set.

The LLM API Key command keeps its current rules: an empty value clears it, and there is no length or format check.

#### Same-value warning

If a key being set equals the other key, either command shows a modal warning: the two keys are identical, so anyone with the LLM key gets full control. The user may continue with **Yes**. This applies to both commands.

#### Secret restore

`extension.ts` restores both keys before starting either server, as it does for the LLM key today.

If reading a secret fails, AM must not fall back to "no key". Today a failed LLM key read disables authentication. The new behavior:

- The affected key enters a **locked** state, and every route that key would grant returns `503`, with a message to re-set the key.
- Setting the key again clears the locked state.

### Authorization rules

| Configured keys | LLM routes           | `/api/v1/*`, `/openapi.json`, MCP |
| --------------- | -------------------- | --------------------------------- |
| None            | Allowed              | Allowed                           |
| LLM only        | LLM key or Admin key | **Rejected** (403)                |
| Admin only      | Admin key            | Admin key                         |
| Both            | LLM key or Admin key | Admin key                         |

Setting any key signals that AM is reachable by others. Rejecting control routes when only the LLM key is set prevents a user from protecting inference while leaving workspace control open. The 403 message tells the user to set an Admin API Key.

The new `GET /health` route is exempt from authentication and from the origin policy.

### Headers

Header names do not change. The route decides which keys a header may carry.

| Route                        | Accepted header(s)                           |
| ---------------------------- | -------------------------------------------- |
| `/api/anthropic/*`           | `x-api-key`                                  |
| `/api/openai/*`              | `Authorization: Bearer <key>`                |
| `/api/gemini/*`              | `x-goog-api-key`                             |
| `/api/v1/*`, `/openapi.json` | `Authorization: Bearer <key>` or `x-api-key` |
| MCP Server                   | `Authorization: Bearer <key>` or `x-api-key` |

Where two headers are accepted, the request passes if either one matches.

Error bodies keep each API's native format:

| Route class | Format                                                               |
| ----------- | -------------------------------------------------------------------- |
| Anthropic   | `authentication_error`                                               |
| OpenAI      | `invalid_api_key`                                                    |
| Gemini      | `UNAUTHENTICATED`                                                    |
| `/api/v1`   | Existing route error shape. Confirm the shape during implementation. |

Status codes:

- Missing or wrong key: `401`.
- "LLM only" configuration on a control route: `403`.
- Locked key: `503`.

Failed attempts are logged at `warn` with the route class and the reason (missing, invalid, forbidden). Key values are never logged.

### Origin policy

Two settings, read on every request (Proxy) or session creation (MCP), so changes need no restart:

```jsonc
"agent-maestro.proxyServerCorsOrigins": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "markdownDescription": "Browser origins allowed to call the Proxy Server, e.g. `http://localhost:5173`, `https://xxxx.devtunnels.ms`. `*` allows any origin. Clients that send no `Origin` header (CLIs, SDKs) are unaffected."
},
"agent-maestro.mcpServerCorsOrigins": {
  "type": "array",
  "items": { "type": "string" },
  "default": [],
  "markdownDescription": "Browser origins allowed to open MCP sessions. `*` allows any origin. Clients that send no `Origin` header are unaffected."
}
```

Origins are exact `scheme://host[:port]` strings. `localhost` alone does not match `http://localhost:5173`.

#### Rules

The defense is a server-side `Origin` check, not CORS response headers. CORS headers only control whether a browser can read a response. They do not stop a simple request from executing.

| Request                                    | Result                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| No `Origin` header                         | Continue to authentication                                    |
| `Origin` in the allowlist, or list has `*` | Continue to authentication; CORS headers are added            |
| `Origin` not allowed                       | `403` before authentication and before the route handler runs |

This blocks both browser cross-origin reads and simple-request writes without auditing each handler's content-type handling. Same-origin pages served by AM itself would send `Origin` on `POST`; AM serves no pages today, so this case does not arise.

#### Proxy Server

- Replace `cors()` with middleware that applies the rules above to every route except `GET /health`.
- For allowed origins, respond with `Access-Control-Allow-Origin` set to the request origin and `Vary: Origin`. Answer preflights, allowing the methods `GET, POST, PUT, DELETE, OPTIONS` and the headers `Authorization`, `x-api-key`, `x-goog-api-key`, and `content-type`. Do not set `Allow-Credentials`; AM does not use cookies.

#### MCP Server

- The check runs in FastMCP's `authenticate(request)` hook (see [MCP Server](#mcp-server)).
- mcp-proxy still reflects CORS headers on every response, and AM cannot change that. This is acceptable: a rejected origin never gets a session, so it never obtains an `mcp-session-id` to use.

#### Warning for `*`

When an origin list contains `*` and no key is configured, AM logs a `warn` at startup and whenever that setting or a key changes. README states that `*` should be combined with keys.

### Health endpoint

Add `GET /health` to the Proxy Server. It returns `{ "name": "Agent Maestro" }` and needs no key or origin check.

`isAgentMaestroService` in `src/utils/portUtils.ts` switches from `/api/v1/info` to `/health`, so port-conflict detection keeps working when keys are set. `/api/v1/info` is unchanged and requires the Admin key like the other `/api/v1` routes.

The MCP Server's existing `/health` remains public.

### MCP Server

Use FastMCP's `authenticate(request)` option. mcp-proxy calls it only when a session is created: the streamable-HTTP `initialize` request and the SSE `GET /sse`. It runs:

1. The origin check against `mcpServerCorsOrigins`.
2. The admin access check from the rules table.

On failure it throws a `Response` with the matching status (`403`, `401`, or `503`). mcp-proxy turns a thrown `Response` into an HTTP response with that status.

Because later requests are authorized only by `mcp-session-id`, AM **restarts the MCP Server whenever the Admin API Key or the LLM API Key changes.** The LLM key matters too, because it changes which row of the rules table applies. A restart drops existing sessions. Clients must reconnect with the new key.

Public MCP endpoints that remain: `/health`, `/ready`, `/ping`. `/ready` reveals only session counts.

> **TODO (follow-up PR):** Upgrade to `fastmcp@4.x` (`mcp-proxy@6.x`). In those versions `start({ httpStream: { cors } })` makes MCP CORS configurable, and `authenticate` runs on every request before session lookup. After upgrading, pass `mcpServerCorsOrigins` as `cors.origin` and replace the restart-on-key-change with per-request authentication. This PR does not upgrade because both are major-version bumps.

### Implementation sketch

- `src/server/middleware/authMiddleware.ts`
  - The three LLM middlewares take a key-state provider, `{ llm, admin }`, where each entry is a key, unset, or locked, and accept either key.
  - Add `createAdminAuthMiddleware` for `/api/v1/*` and `/openapi.json`.
  - Export pure functions `checkAdminAccess(keyState, headers)` and `checkOrigin(origin, allowlist)` for reuse by MCP and tests.
- New origin middleware, registered first in `ProxyServer`.
- `src/server/ProxyServer.ts` — admin key state, setter, restore with the locked state, `GET /health`, and middleware order: origin, then auth, then routes.
- `src/server/McpServer.ts` — the `authenticate` hook, a key-state getter, and the restart triggered by key changes.
- `src/commands/` — the new command, the same-value warning in both commands, and registration in `package.json`.
- `src/utils/portUtils.ts` — probe `/health`.
- `src/utils/config.ts` and `package.json` — the two origin settings.

## Compatibility

| User                                         | Effect                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| No keys, CLI/SDK clients                     | None                                                                                    |
| LLM key set, only LLM clients                | None                                                                                    |
| LLM key set, also calls `/api/v1` or MCP     | Must set the Admin API Key and send it                                                  |
| Browser app on another origin (Proxy or MCP) | Must add the origin to the matching setting                                             |
| `examples/demo-site`                         | Must add its origin; once any key is set, it is blocked because it sends no auth header |
| Secret storage read failure                  | Routes return 503 until the key is re-set, instead of silently opening                  |

Release as a **minor** changeset that calls out each breaking row.

## Documentation

- `README.md`:
  - Both keys and the Set Admin API Key options.
  - The authorization rules table.
  - The origin settings, with the `*` warning.
  - Remote access through VS Code port forwarding: set the Ports-panel protocol to HTTP. A public tunnel requires an Admin API Key. A private tunnel requires a dev tunnel login that CLI clients cannot complete without extra tokens.
  - The no-key trust model and the accepted residual risks.
- `examples/demo-site/README.md`: replace "AM currently uses permissive CORS" and the "LLM API key covers only…" warning with the new settings and Admin key guidance. Making the demo send an Admin key is out of scope.
- `docs/README.md`: add this record to Design Records.

## Tests

- **Rules table:** every key combination (none, LLM only, Admin only, both) × route class (LLM, `/api/v1`, `/openapi.json`) × header variant, including missing-key, wrong-key, and 403 cases.
- **Admin key on LLM routes:** the LLM routes accept the Admin key in each route's native header.
- **Locked key:** a secret read failure yields 503, never open access; re-setting the key unlocks it.
- **Origin policy:**
  - No `Origin` passes.
  - An allowlisted `Origin` passes, gets CORS headers and `Vary: Origin`, and its preflight succeeds.
  - Any other `Origin` gets 403 before the handler runs, including a `POST /api/v1/fs/write` with `Content-Type: text/plain`.
  - `*` allows every origin.
  - A settings change applies without restart.
- **Health:**
  - `GET /health` is public, including when both keys are set.
  - `isAgentMaestroService` detects AM with keys set.
- **Commands:**
  - Generated keys match `^am_[A-Za-z0-9_-]{43}$`.
  - Manual-entry validation enforces at least 16 characters and no whitespace.
  - The same-value warning appears.
  - These are unit-tested where possible; the QuickPick and clipboard flows are UI and need manual verification.
- **MCP:**
  - `checkAdminAccess` and `checkOrigin` get unit tests.
  - Session rejection, and session invalidation after a key change, need a manual check against the running server.
