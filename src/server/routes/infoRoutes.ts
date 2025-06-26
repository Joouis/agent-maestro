import { FastifyInstance } from "fastify";
import * as vscode from "vscode";
import * as os from "os";
import { logger } from "../../utils/logger";
import { ExtensionController } from "../../core/controller";
import packageJson from "../../../package.json";
import type { McpServer } from "../../server/McpServer";

export async function registerInfoRoutes(
  fastify: FastifyInstance,
  controller: ExtensionController,
  mcpServer: McpServer,
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
                properties: {
                  cline: {
                    type: "object",
                    properties: {
                      isInstalled: { type: "boolean" },
                      isActive: { type: "boolean" },
                      version: { type: "string" },
                    },
                    required: ["isInstalled", "isActive"],
                  },
                  roo: {
                    type: "object",
                    properties: {
                      isInstalled: { type: "boolean" },
                      isActive: { type: "boolean" },
                      version: { type: "string" },
                    },
                    required: ["isInstalled", "isActive"],
                  },
                },
                required: ["cline", "roo"],
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
              mcpServer: {
                type: "object",
                properties: {
                  isRunning: { type: "boolean" },
                  port: { type: "number" },
                  url: { type: "string" },
                },
                required: ["isRunning", "port", "url"],
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
              "mcpServer",
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
        // Get extension name and version from package.json
        const name = packageJson.displayName || packageJson.name;
        const version = packageJson.version;

        // Get extension status from controller
        const extensionStatus = controller.getExtensionStatus();

        // Get VSCode version
        const vscodeVersion = vscode.version;

        // Get OS information in the format: "Platform Architecture Release"
        // Convert platform names to match expected format
        const platform = os.platform();
        let platformName: string = platform;
        if (platform === "darwin") {
          platformName = "Darwin";
        } else if (platform === "win32") {
          platformName = "Windows";
        } else if (platform === "linux") {
          platformName = "Linux";
        }

        const arch = os.arch();
        const release = os.release();
        const osInfo = `${platformName} ${arch} ${release}`;

        // Get workspace root path
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workspace = workspaceFolder?.uri.fsPath || "No workspace";

        // Get MCP server status
        const mcpStatus = mcpServer.getStatus();

        // Build response with the exact structure required
        const response = {
          name,
          version,
          extensions: {
            cline: {
              isInstalled: extensionStatus.cline.isInstalled,
              isActive: extensionStatus.cline.isActive,
              version: extensionStatus.cline.version || "Unknown",
            },
            roo: {
              isInstalled: extensionStatus.roo.isInstalled,
              isActive: extensionStatus.roo.isActive,
              version: extensionStatus.roo.version || "Unknown",
            },
          },
          vscodeVersion,
          os: osInfo,
          workspace,
          mcpServer: {
            isRunning: mcpStatus.isRunning,
            port: mcpStatus.port,
            url: mcpStatus.url,
          },
          timestamp: new Date().toISOString(),
        };

        logger.info("System info request completed", {
          vscodeVersion,
          workspace:
            workspace.length > 50
              ? workspace.substring(0, 50) + "..."
              : workspace,
          mcpRunning: mcpStatus.isRunning,
        });

        return reply.send(response);
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
