import { FastifyInstance } from "fastify";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import { getSystemInfo } from "../../utils/systemInfo";

export async function registerInfoRoutes(
  fastify: FastifyInstance,
  controller: ExtensionController,
) {
  // GET /api/v1/info - Get system and extension information
  fastify.get(
    "/info",
    {
      schema: {
        tags: ["System"],
        summary: "Get Agent Maestro system information",
        description:
          "Returns comprehensive system information including extension status, VSCode version, OS details, workspace, and MCP server status",
        response: {
          200: {
            description: "System information retrieved successfully",
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Extension name",
                example: "Agent Maestro",
              },
              version: {
                type: "string",
                description: "Extension version",
                example: "0.4.0",
              },
              extensions: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  properties: {
                    isInstalled: { type: "boolean" },
                    isActive: { type: "boolean" },
                    version: { type: "string" },
                  },
                  required: ["isInstalled", "isActive"],
                },
              },
              vscodeVersion: {
                type: "string",
                description: "VSCode version",
                example: "1.100.0",
              },
              os: {
                type: "string",
                description:
                  "Operating system information in format: Platform Architecture Release",
                example: "Darwin arm64 24.5.0",
              },
              workspace: {
                type: "string",
                description: "Current workspace root path",
                example: "/Users/joou/workspace/agent-maestro",
              },
              timestamp: {
                type: "string",
                format: "date-time",
                description: "Response timestamp in ISO format",
              },
            },
            required: [
              "name",
              "version",
              "extensions",
              "vscodeVersion",
              "os",
              "workspace",
              "timestamp",
            ],
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (_request, reply) => {
      try {
        const systemInfo = getSystemInfo(controller);
        return reply.send(systemInfo);
      } catch (error) {
        logger.error("Error retrieving system information:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );
}
