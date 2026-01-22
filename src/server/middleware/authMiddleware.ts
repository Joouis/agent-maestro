import type { Context, Next } from "hono";

import { constantTimeEqual } from "../../utils/crypto";
import { logger } from "../../utils/logger";

/**
 * Creates Anthropic authentication middleware.
 * Validates the `x-api-key` header against the configured API key.
 */
export function createAnthropicAuthMiddleware(
  getApiKey: () => string | null,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const configuredKey = getApiKey();

    // If no key is configured, skip authentication
    if (!configuredKey) {
      return next();
    }

    const providedKey = c.req.header("x-api-key");

    if (!providedKey || !constantTimeEqual(providedKey, configuredKey)) {
      logger.warn(
        `Anthropic API authentication failed: ${providedKey ? "invalid key" : "missing key"}`,
      );
      return c.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "Invalid API key",
          },
        },
        401,
      );
    }

    return next();
  };
}

/**
 * Creates OpenAI authentication middleware.
 * Validates the `Authorization: Bearer <token>` header against the configured API key.
 */
export function createOpenAIAuthMiddleware(
  getApiKey: () => string | null,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const configuredKey = getApiKey();

    // If no key is configured, skip authentication
    if (!configuredKey) {
      return next();
    }

    const authHeader = c.req.header("Authorization");
    let providedKey: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      providedKey = authHeader.slice(7); // Remove "Bearer " prefix
    }

    if (!providedKey || !constantTimeEqual(providedKey, configuredKey)) {
      logger.warn(
        `OpenAI API authentication failed: ${providedKey ? "invalid key" : "missing key"}`,
      );
      return c.json(
        {
          error: {
            message: "Incorrect API key provided",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        },
        401,
      );
    }

    return next();
  };
}

/**
 * Creates Gemini authentication middleware.
 * Validates either the `x-goog-api-key` header or `key` query parameter against the configured API key.
 */
export function createGeminiAuthMiddleware(
  getApiKey: () => string | null,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const configuredKey = getApiKey();

    // If no key is configured, skip authentication
    if (!configuredKey) {
      return next();
    }

    // Check header first, then query parameter
    const headerKey = c.req.header("x-goog-api-key");
    const queryKey = c.req.query("key");
    const providedKey = headerKey || queryKey;

    if (!providedKey || !constantTimeEqual(providedKey, configuredKey)) {
      logger.warn(
        `Gemini API authentication failed: ${providedKey ? "invalid key" : "missing key"}`,
      );
      return c.json(
        {
          error: {
            code: 401,
            message: "API key not valid. Please pass a valid API key.",
            status: "UNAUTHENTICATED",
          },
        },
        401,
      );
    }

    return next();
  };
}
