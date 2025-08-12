import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import {
  ErrorResponseSchema,
  ImagesDataUriSchema,
  imagesDataUriErrorMessage,
  ClineMessageRequestSchema,
  ClineTaskResponseSchema,
} from "../schemas";

// OpenAPI route definition
const clineTaskRoute = createRoute({
  method: "post",
  path: "/cline/task",
  tags: ["Tasks"],
  summary: "Create a new Cline task",
  description: "Creates and starts a new task using the Cline extension",
  request: {
    body: {
      content: {
        "application/json": {
          schema: ClineMessageRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ClineTaskResponseSchema,
        },
      },
      description: "Task created successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - invalid input data",
    },
    500: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Internal server error",
    },
  },
});

export function registerClineRoutes(
  app: OpenAPIHono,
  controller: ExtensionController,
) {
  // POST /api/v1/cline/task - Create new Cline task
  app.openapi(clineTaskRoute, async (c) => {
    try {
      const { text, images } = await c.req.json();

      const parsedImages = ImagesDataUriSchema.safeParse(images);
      if (!parsedImages.success) {
        return c.json({ message: imagesDataUriErrorMessage }, 400);
      }

      if (!controller.clineAdapter.isActive) {
        return c.json({ message: "Cline extension is not available" }, 500);
      }

      await controller.clineAdapter.startNewTask({
        task: text,
        images,
      });

      const response = {
        id: "Cline does not support returning task ID",
        status: "completed" as const,
        message: "Currently Cline does not support returning message",
      };

      logger.info(`Created new Cline task: ${response.id}`);
      return c.json(response, 200);
    } catch (error) {
      logger.error("Error creating Cline task:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });
}
