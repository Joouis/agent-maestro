import { z } from "@hono/zod-openapi";

export const AnthropicErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string().describe("Error message"),
      type: z.string().describe("Error type"),
    }),
    type: z.string().describe("Error type"),
  })
  .openapi("AnthropicErrorResponse");
