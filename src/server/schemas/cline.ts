import { z } from "@hono/zod-openapi";

export const imagesDataUriErrorMessage =
  "Each image must be a valid data URI in format 'data:image/{fileType};base64,...'";
export const ImagesDataUriSchema = z
  .array(
    z
      .string()
      .refine(
        (value) =>
          value.startsWith("data:image/") && value.includes(";base64,"),
        {
          error: imagesDataUriErrorMessage,
        },
      ),
  )
  .optional()
  .describe(
    'Optional array of image data URIs (e.g., "data:image/webp;base64,...").',
  );

export const ClineMessageRequestSchema = z.object({
  text: z.string().min(1).describe("The task description to execute"),
  images: ImagesDataUriSchema,
});

export const ClineTaskResponseSchema = z.object({
  id: z.string().describe("Unique task identifier"),
  status: z
    .enum(["created", "running", "completed", "failed"])
    .describe("Current task status"),
  message: z.string().describe("Status message"),
});
