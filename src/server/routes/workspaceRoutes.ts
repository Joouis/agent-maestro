import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as vscode from "vscode";
import * as fs from "fs/promises";
import { logger } from "../../utils/logger";
import {
  WorkspaceUpdateRequest,
  WorkspaceUpdateResponse,
  CloseWorkspacesResponse,
} from "../types";

const registerSchemas = (fastify: FastifyInstance) => {
  fastify.addSchema({
    $id: "WorkspaceUpdateRequest",
    type: "object",
    required: ["folders"],
    properties: {
      folders: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Array of absolute paths for workspace folders to add",
      },
    },
  });

  fastify.addSchema({
    $id: "WorkspaceUpdateResponse",
    type: "object",
    properties: {
      success: {
        type: "boolean",
        description: "Whether the operation succeeded",
      },
      message: {
        type: "string",
        description: "Status message",
      },
      workspaceFolders: {
        type: "array",
        items: {
          type: "object",
          properties: {
            uri: {
              type: "string",
              description: "Workspace folder URI",
            },
            name: {
              type: "string",
              description: "Workspace folder name",
            },
            index: {
              type: "number",
              description: "Index in workspace folders list",
            },
          },
        },
        description: "Current workspace folders after update",
      },
    },
  });

  fastify.addSchema({
    $id: "CloseWorkspacesResponse",
    type: "object",
    properties: {
      success: {
        type: "boolean",
        description: "Whether the operation succeeded",
      },
      message: {
        type: "string",
        description: "Status message",
      },
    },
  });
};

export async function registerWorkspaceRoutes(fastify: FastifyInstance) {
  registerSchemas(fastify);

  // POST /api/v1/workspace/updateWorkspaceFolders - Update workspace folders
  fastify.post(
    "/workspace/updateWorkspaceFolders",
    {
      schema: {
        tags: ["Workspace"],
        summary: "Update workspace folders",
        description:
          "Adds new workspace folders to the workspace. Note: This operation may fail if existing workspace folders are open. It's recommended to call /workspace/closeAllWorkspaces first to ensure reliability. Both operations will trigger a workspace window reload.",
        body: { $ref: "WorkspaceUpdateRequest#" },
        response: {
          200: {
            description: "Workspace folders updated successfully",
            $ref: "WorkspaceUpdateResponse#",
          },
          400: {
            description: "Bad request - invalid parameters",
            $ref: "ErrorResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { folders } = request.body as WorkspaceUpdateRequest;

        // Check if all folders exist before proceeding
        const invalidFolders: string[] = [];
        for (const folder of folders) {
          try {
            const stats = await fs.stat(folder);
            if (!stats.isDirectory()) {
              invalidFolders.push(`${folder} (not a directory)`);
            }
          } catch (error) {
            invalidFolders.push(`${folder} (does not exist)`);
          }
        }

        if (invalidFolders.length > 0) {
          return reply.status(400).send({
            message: `Invalid folders: ${invalidFolders.join(", ")}`,
          });
        }

        // Add the new workspace folders
        if (folders.length > 0) {
          // Convert string paths to workspace folders
          const workspaceFolderObjects = folders.map((folderPath) => ({
            uri: vscode.Uri.file(folderPath),
          }));

          const addSuccess = vscode.workspace.updateWorkspaceFolders(
            0,
            0,
            ...workspaceFolderObjects,
          );

          if (!addSuccess) {
            return reply.status(500).send({
              message: "Failed to add new workspace folders",
            });
          }

          logger.info(`Added ${folders.length} new workspace folders`);
        }

        // Get updated workspace folders
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(
          (folder, index) => ({
            uri: folder.uri.toString(),
            name: folder.name,
            index,
          }),
        );

        const response: WorkspaceUpdateResponse = {
          success: true,
          message: `Successfully updated workspace folders. ${folders.length} folders added.`,
          workspaceFolders,
        };

        logger.info(
          `Workspace folders updated: added=${folders.length} folders`,
        );

        return reply.send(response);
      } catch (error) {
        logger.error("Error updating workspace folders:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );

  // POST /api/v1/workspace/closeAllWorkspaces - Close all workspace folders
  fastify.post(
    "/workspace/closeAllWorkspaces",
    {
      schema: {
        tags: ["Workspace"],
        summary: "Close all workspace folders",
        description:
          "Closes all currently open workspace folders in the workspace. This operation will trigger a workspace window reload.",
        response: {
          200: {
            description: "Workspace folders closed successfully",
            $ref: "CloseWorkspacesResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Get current workspace folders count
        const currentWorkspaceFolders = vscode.workspace.workspaceFolders || [];
        const currentCount = currentWorkspaceFolders.length;

        if (currentCount === 0) {
          const response: CloseWorkspacesResponse = {
            success: true,
            message: "No workspace folders to close",
          };
          return reply.send(response);
        }

        // Close all existing workspaces
        const closeSuccess = vscode.workspace.updateWorkspaceFolders(
          0,
          currentCount,
        );

        if (!closeSuccess) {
          return reply.status(500).send({
            message: "Failed to close workspace folders",
          });
        }

        const response: CloseWorkspacesResponse = {
          success: true,
          message: `Successfully closed ${currentCount} workspace folders`,
        };

        logger.info(`Closed ${currentCount} workspace folders`);
        return reply.send(response);
      } catch (error) {
        logger.error("Error closing workspace folders:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );
}
