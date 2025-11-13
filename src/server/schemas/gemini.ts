import { z } from "@hono/zod-openapi";

export const GeminiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.number().describe("HTTP status code"),
      message: z.string().describe("Error message"),
      status: z.string().describe("Error status code (e.g., INVALID_ARGUMENT)"),
    }),
  })
  .openapi("GeminiErrorResponse");
