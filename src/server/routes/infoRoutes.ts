import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { getSystemInfo } from "../../utils/systemInfo";
import { ErrorResponseSchema } from "../schemas";

// Zod schemas for validation and OpenAPI documentation
const ExtensionInfoSchema = z.object({
  isInstalled: z.boolean().describe("Whether the extension is installed"),
  isActive: z.boolean().describe("Whether the extension is active"),
  version: z.string().optional().describe("Extension version if available"),
});

const OSInfoSchema = z.object({
  platform: z
    .string()
    .describe("Operating system platform, get from os.platform() of Node.js")
    .openapi({ example: "darwin" }),
  arch: z
    .string()
    .describe("System architecture, get from os.arch() of Node.js")
    .openapi({ example: "arm64" }),
  release: z
    .string()
    .describe("OS release version, get from os.release() of Node.js")
    .openapi({ example: "24.5.0" }),
  homedir: z
    .string()
    .describe("User home directory path, get from os.homedir() of Node.js"),
});

const SystemInfoSchema = z.object({
  name: z
    .string()
    .describe("Extension name")
    .openapi({ example: "Agent Maestro" }),
  version: z
    .string()
    .describe("Extension version")
    .openapi({ example: "1.3.1" }),
  extensions: z
    .record(z.string(), ExtensionInfoSchema)
    .describe("Information about installed extensions"),
  vscodeVersion: z
    .string()
    .describe("VSCode version")
    .openapi({ example: "1.100.0" }),
  os: OSInfoSchema.describe("Operating system information"),
  workspace: z
    .string()
    .describe("Current workspace root path")
    .openapi({ example: "/Users/joou/workspace/agent-maestro" }),
  timestamp: z.iso.datetime().describe("Response timestamp in ISO format"),
});

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
