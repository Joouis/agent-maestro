import { z } from "@hono/zod-openapi";

export const ErrorResponseSchema = z
  .object({
    message: z.string().describe("Error message"),
  })
  .openapi("ErrorResponse");
