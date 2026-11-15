import type { Context, Next } from "hono";
import { cors } from "hono/cors";

import { logger } from "../../utils/logger";

export function isOriginAllowed(origin: string, allowlist: string[]): boolean {
  return allowlist.includes("*") || allowlist.includes(origin);
}

/**
 * Rejects browser requests from origins outside the allowlist before any
 * handler runs. CORS headers alone are not enough: a "simple" request
 * (e.g. `POST` with `text/plain`) skips preflight and would still execute.
 * Requests without `Origin` (CLIs, SDKs) are unaffected.
 */
export function createOriginGuardMiddleware(
  getAllowlist: () => string[],
  exemptPaths: string[],
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const origin = c.req.header("origin");
    if (
      origin === undefined ||
      exemptPaths.includes(c.req.path) ||
      isOriginAllowed(origin, getAllowlist())
    ) {
      return next();
    }
    logger.warn(`Rejected request from disallowed origin: ${origin}`);
    return c.json({ message: "Origin not allowed" }, 403);
  };
}

/**
 * Emits CORS headers only for allowlisted origins; never wildcard or
 * credentials. Preflight echoes the requested headers: SDKs send many of
 * their own (`anthropic-version`, `x-stainless-*`, `x-goog-api-client`), and
 * restricting them adds no security once the origin is allowed and the key
 * is checked.
 */
export function createCorsMiddleware(getAllowlist: () => string[]) {
  return cors({
    origin: (origin) =>
      isOriginAllowed(origin, getAllowlist()) ? origin : null,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });
}
