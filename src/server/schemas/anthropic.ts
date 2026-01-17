import { z } from "@hono/zod-openapi";

export const AnthropicErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string().describe("Error message"),
      type: z.string().describe("Error type"),
      log_file: z
        .string()
        .optional()
        .describe("Path to debug log file with detailed error context"),
      hint: z
        .string()
        .optional()
        .describe("Optional hint for resolving the error"),
    }),
  })
  .openapi("AnthropicErrorResponse");
