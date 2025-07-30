import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { getSystemInfo } from "../../utils/systemInfo";
import { ErrorResponseSchema, SystemInfoSchema } from "../schemas";

// OpenAPI route definition
const systemInfoRoute = createRoute({
  method: "get",
  path: "/info",
  tags: ["System"],
  summary: "Get Agent Maestro system information",
  description:
    "Returns comprehensive system information including extension status, VSCode version, OS details, workspace, and MCP server status",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: SystemInfoSchema,
        },
      },
      description: "System information retrieved successfully",
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

export function registerInfoRoutes(
  app: OpenAPIHono,
  controller: ExtensionController,
) {
  // GET /api/v1/info - Get system and extension information
  app.openapi(systemInfoRoute, async (c) => {
    try {
      const systemInfo = getSystemInfo(controller);
      return c.json(systemInfo, 200);
    } catch (error) {
      logger.error("Error retrieving system information:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });
}
