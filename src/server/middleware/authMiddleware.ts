import type { Context, Next } from "hono";

import { HttpAuthentication } from "../httpAuthentication";

export type ApiProtocol = "control" | "anthropic" | "openai" | "gemini";

export function createApiAuthMiddleware(
  authentication: Pick<HttpAuthentication, "authorize">,
  protocol: ApiProtocol,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    const key =
      protocol === "anthropic"
        ? c.req.header("x-api-key")
        : protocol === "gemini"
          ? c.req.header("x-goog-api-key")
          : /^Bearer ([^\s].*)$/i.exec(
              c.req.header("Authorization") ?? "",
            )?.[1];
    let result;
    try {
      result = await authentication.authorize(key);
    } catch {
      result = "unavailable";
    }
    if (result === "allowed") {
      return next();
    }
    const status = result === "denied" ? 401 : 503;
    if (result === "busy") {
      c.header("Retry-After", "1");
    }
    const message =
      result === "busy"
        ? "API authentication is busy. Retry after one second."
        : status === 401
          ? "Invalid API key"
          : "API authentication unavailable. Run Agent Maestro: Set API Key in VS Code to configure or recover access, then retry.";
    switch (protocol) {
      case "anthropic":
        return c.json(
          {
            type: "error",
            error: {
              type: status === 401 ? "authentication_error" : "api_error",
              message,
            },
          },
          status,
        );
      case "openai":
        return c.json(
          {
            error: {
              message,
              type: status === 401 ? "invalid_request_error" : "server_error",
              code:
                status === 401
                  ? "invalid_api_key"
                  : "authentication_unavailable",
            },
          },
          status,
        );
      case "gemini":
        return c.json(
          {
            error: {
              code: status,
              message,
              status: status === 401 ? "UNAUTHENTICATED" : "UNAVAILABLE",
            },
          },
          status,
        );
      case "control":
        if (status === 401) {
          c.header("WWW-Authenticate", 'Bearer realm="Agent Maestro API"');
        }
        return c.json({ message }, status);
    }
  };
}
