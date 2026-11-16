import type { Context, Next } from "hono";

import { constantTimeEqual } from "../../utils/crypto";
import { logger } from "../../utils/logger";

/**
 * `locked` means the key exists in secret storage but could not be read.
 * Routes the key would grant must fail closed instead of treating it as unset.
 */
export type ApiKeyState =
  | { status: "unset" }
  | { status: "set"; value: string }
  | { status: "locked" };

export interface ApiKeys {
  llm: ApiKeyState;
  admin: ApiKeyState;
}

export type AccessResult =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 403 | 503;
      reason: "missing" | "invalid" | "forbidden" | "locked";
    };

type HeaderReader = (name: string) => string | undefined;

const ALLOW: AccessResult = { ok: true };

function matches(provided: (string | undefined)[], key: ApiKeyState): boolean {
  if (key.status !== "set") {
    return false;
  }
  return provided.some(
    (value) => value !== undefined && constantTimeEqual(value, key.value),
  );
}

function rejectCredentials(provided: (string | undefined)[]): AccessResult {
  return {
    ok: false,
    status: 401,
    reason: provided.some((value) => value !== undefined)
      ? "invalid"
      : "missing",
  };
}

/**
 * LLM routes accept either key. A locked key fails closed because the Admin
 * key grants every route and the LLM key grants these routes.
 */
export function checkLlmAccess(
  keys: ApiKeys,
  provided: (string | undefined)[],
): AccessResult {
  if (keys.llm.status === "locked" || keys.admin.status === "locked") {
    return { ok: false, status: 503, reason: "locked" };
  }
  if (keys.llm.status === "unset" && keys.admin.status === "unset") {
    return ALLOW;
  }
  if (matches(provided, keys.llm) || matches(provided, keys.admin)) {
    return ALLOW;
  }
  return rejectCredentials(provided);
}

/**
 * Control routes (`/api/v1/*`, `/openapi.json`) accept only the Admin key.
 * A configured LLM key without an Admin key signals remote exposure, so
 * control routes are refused rather than left open.
 */
export function checkAdminAccess(
  keys: ApiKeys,
  provided: (string | undefined)[],
): AccessResult {
  if (keys.admin.status === "locked") {
    return { ok: false, status: 503, reason: "locked" };
  }
  if (keys.admin.status === "set") {
    return matches(provided, keys.admin) ? ALLOW : rejectCredentials(provided);
  }
  if (keys.llm.status === "locked") {
    return { ok: false, status: 503, reason: "locked" };
  }
  if (keys.llm.status === "set") {
    return { ok: false, status: 403, reason: "forbidden" };
  }
  return ALLOW;
}

export function readBearerToken(
  authorization: string | undefined,
): string | undefined {
  return authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

/** Credentials accepted on control routes. */
export function readAdminCredentials(
  header: HeaderReader,
): (string | undefined)[] {
  return [readBearerToken(header("authorization")), header("x-api-key")];
}

const LOCKED_MESSAGE =
  "API key could not be loaded from secret storage. Set the key again in VS Code to restore access.";
const FORBIDDEN_MESSAGE =
  "This route requires an Admin API Key. Run 'Agent Maestro: Set Admin API Key' in VS Code.";

// A concrete shape keeps c.json's recursive JSON typing from overflowing.
type LlmErrorBody = (result: Extract<AccessResult, { ok: false }>) => {
  type?: string;
  error: Record<string, string | number>;
};

function createLlmAuthMiddleware(
  label: string,
  readCredentials: (header: HeaderReader) => (string | undefined)[],
  errorBody: LlmErrorBody,
  getKeys: () => ApiKeys,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const result = checkLlmAccess(
      getKeys(),
      readCredentials((name) => c.req.header(name)),
    );
    if (result.ok) {
      return next();
    }
    logger.warn(`${label} API authentication failed: ${result.reason}`);
    return c.json(errorBody(result), result.status);
  };
}

/** Validates `x-api-key` on Anthropic routes. */
export function createAnthropicAuthMiddleware(getKeys: () => ApiKeys) {
  return createLlmAuthMiddleware(
    "Anthropic",
    (header) => [header("x-api-key")],
    (result) => ({
      type: "error",
      error:
        result.status === 503
          ? { type: "api_error", message: LOCKED_MESSAGE }
          : { type: "authentication_error", message: "Invalid API key" },
    }),
    getKeys,
  );
}

/** Validates `Authorization: Bearer <key>` on OpenAI routes. */
export function createOpenAIAuthMiddleware(getKeys: () => ApiKeys) {
  return createLlmAuthMiddleware(
    "OpenAI",
    (header) => [readBearerToken(header("authorization"))],
    (result) => ({
      error:
        result.status === 503
          ? {
              message: LOCKED_MESSAGE,
              type: "server_error",
              code: "api_key_unavailable",
            }
          : {
              message: "Incorrect API key provided",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
    }),
    getKeys,
  );
}

/** Validates `x-goog-api-key` on Gemini routes. */
export function createGeminiAuthMiddleware(getKeys: () => ApiKeys) {
  return createLlmAuthMiddleware(
    "Gemini",
    (header) => [header("x-goog-api-key")],
    (result) => ({
      error:
        result.status === 503
          ? { code: 503, message: LOCKED_MESSAGE, status: "UNAVAILABLE" }
          : {
              code: 401,
              message: "API key not valid. Please pass a valid API key.",
              status: "UNAUTHENTICATED",
            },
    }),
    getKeys,
  );
}

export function adminAccessMessage(
  result: Extract<AccessResult, { ok: false }>,
): string {
  switch (result.reason) {
    case "locked":
      return LOCKED_MESSAGE;
    case "forbidden":
      return FORBIDDEN_MESSAGE;
    default:
      return "Invalid or missing Admin API Key";
  }
}

/** Validates the Admin key on `/api/v1/*` and `/openapi.json`. */
export function createAdminAuthMiddleware(
  getKeys: () => ApiKeys,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const result = checkAdminAccess(
      getKeys(),
      readAdminCredentials((name) => c.req.header(name)),
    );
    if (result.ok) {
      return next();
    }
    logger.warn(`Admin API authentication failed: ${result.reason}`);
    return c.json({ message: adminAccessMessage(result) }, result.status);
  };
}
