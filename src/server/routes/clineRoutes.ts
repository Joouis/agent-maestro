import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "zod";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { ErrorResponseSchema } from "../schemas";

// Zod schemas for validation and OpenAPI documentation
const MessageRequestSchema = z.object({
  text: z.string().min(1).describe("The task description to execute"),
  images: z
    .array(z.string())
    .optional()
    .describe("Optional array of base64-encoded images"),
});

const TaskResponseSchema = z.object({
  id: z.string().describe("Unique task identifier"),
  status: z
    .enum(["created", "running", "completed", "failed"])
    .describe("Current task status"),
  message: z.string().describe("Status message"),
});

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
          schema: MessageRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: TaskResponseSchema,
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
      description: "Bad request - invalid input",
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

      if (!text || text.trim() === "") {
        return c.json({ message: "Task description is required" }, 400);
      }

      if (!controller.clineAdapter.isActive) {
        return c.json({ message: "Cline extension is not available" }, 500);
      }

      await controller.clineAdapter.startNewTask({ task: text, images });

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
