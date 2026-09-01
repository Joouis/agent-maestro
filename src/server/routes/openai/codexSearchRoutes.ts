import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { logger } from "../../../utils/logger";
import {
  CodexSearchRequestValidationError,
  CodexStandaloneWebSearch,
} from "../../webSearch/codexStandaloneWebSearch";
import { ExaMcpError } from "../../webSearch/exaMcpClient";

export const CODEX_SEARCH_BODY_LIMIT_BYTES = 256 * 1_024;

const codexSearchRoute = createRoute({
  method: "post",
  path: "/v1/alpha/search",
  tags: ["Codex Compatibility"],
  summary: "Run Codex standalone web search through Exa",
  description:
    "Experimental compatibility endpoint for the standalone web search protocol used by Codex 0.151.0-alpha.7.1. This is not a public OpenAI Search API.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.unknown(),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            encrypted_output: z.null(),
            output: z.string(),
            results: z.array(
              z.object({
                type: z.literal("text_result"),
                ref_id: z.string(),
                url: z.string().url(),
                title: z.string(),
                snippet: z.string().optional(),
              }),
            ),
          }),
        },
      },
      description: "Codex standalone web-search tool result",
    },
    400: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.object({
              type: z.literal("invalid_request_error"),
              message: z.string(),
              param: z.string().nullable(),
              code: z.literal("invalid_search_request"),
            }),
          }),
        },
      },
      description: "Malformed Codex standalone web-search request",
    },
    499: {
      description: "Client disconnected",
    },
    500: {
      content: {
        "application/json": {
          schema: z.object({
            error: z.object({
              type: z.literal("server_error"),
              message: z.string(),
              param: z.null(),
              code: z.literal("internal_error"),
            }),
          }),
        },
      },
      description: "Unexpected internal error",
    },
  },
});

export interface CodexSearchRoutesOptions {
  codexSearch: CodexStandaloneWebSearch;
}

const invalidRequest = (
  c: Context,
  message: string,
  param: string | null = null,
): Response =>
  c.json(
    {
      error: {
        type: "invalid_request_error",
        message,
        param,
        code: "invalid_search_request",
      },
    },
    400,
  );

export function registerCodexSearchRoutes(
  app: OpenAPIHono,
  options: CodexSearchRoutesOptions,
): void {
  app.use(
    "/v1/alpha/search",
    bodyLimit({
      maxSize: CODEX_SEARCH_BODY_LIMIT_BYTES,
      onError: (c) =>
        invalidRequest(
          c,
          `Request body must not exceed ${CODEX_SEARCH_BODY_LIMIT_BYTES} bytes`,
        ),
    }),
  );
  app.use("/v1/alpha/search", async (c, next) => {
    await next();
    if (
      c.res.status === 400 &&
      (await c.res.clone().text()).startsWith("Malformed JSON")
    ) {
      c.res = invalidRequest(c, "Request body must contain valid JSON");
    }
  });
  app.openapi(
    codexSearchRoute,
    async (c: Context): Promise<Response> => {
      try {
        let request: unknown;
        try {
          request = await c.req.json();
        } catch {
          return invalidRequest(c, "Request body must contain valid JSON");
        }
        const response = await options.codexSearch.execute(
          request,
          c.req.raw.signal,
        );
        return c.json(response, 200);
      } catch (error) {
        if (error instanceof CodexSearchRequestValidationError) {
          return invalidRequest(c, error.message, error.param);
        }
        if (error instanceof ExaMcpError && error.category === "cancelled") {
          logger.info("/v1/alpha/search | client disconnected");
          return new Response(null, { status: 499 });
        }
        logger.error("✕ /v1/alpha/search |", error);
        return c.json(
          {
            error: {
              type: "server_error",
              message: "An internal error occurred",
              param: null,
              code: "internal_error",
            },
          },
          500,
        );
      }
    },
    (result, c) => {
      if (!result.success) {
        return invalidRequest(c, "Request body must contain valid JSON");
      }
    },
  );
}
