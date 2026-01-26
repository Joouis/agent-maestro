import type { Context, Next } from "hono";

import { constantTimeEqual } from "../../utils/crypto";
import { logger } from "../../utils/logger";

/**
 * Creates Anthropic authentication middleware.
 * Validates the `x-api-key` header against the configured LLM API key.
 */
export function createAnthropicAuthMiddleware(
  getLlmApiKey: () => string | null,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const configuredKey = getLlmApiKey();

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
 * Validates the `Authorization: Bearer <token>` header against the configured LLM API key.
 */
export function createOpenAIAuthMiddleware(
  getLlmApiKey: () => string | null,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const configuredKey = getLlmApiKey();

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
 * Validates the `x-goog-api-key` header against the configured LLM API key.
 */
export function createGeminiAuthMiddleware(
  getLlmApiKey: () => string | null,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c: Context, next: Next) => {
    const configuredKey = getLlmApiKey();

    // If no key is configured, skip authentication
    if (!configuredKey) {
      return next();
    }

    const providedKey = c.req.header("x-goog-api-key");

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
