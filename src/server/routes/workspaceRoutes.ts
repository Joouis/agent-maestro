import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as vscode from "vscode";
import * as fs from "fs/promises";
import { logger } from "../../utils/logger";
import {
  ErrorResponseSchema,
  WorkspaceUpdateRequestSchema,
  WorkspaceUpdateResponseSchema,
  CloseWorkspacesResponseSchema,
} from "../schemas";

// OpenAPI route definitions
const updateWorkspaceFoldersRoute = createRoute({
  method: "post",
  path: "/workspace/updateWorkspaceFolders",
  tags: ["Workspace"],
  summary: "Update workspace folders",
  description:
    "Adds new workspace folders to the workspace. Note: This operation may fail if existing workspace folders are open. It's recommended to call /workspace/closeAllWorkspaces first to ensure reliability. Both operations will trigger a workspace window reload.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: WorkspaceUpdateRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: WorkspaceUpdateResponseSchema,
        },
      },
      description: "Workspace folders updated successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - invalid parameters",
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

const closeAllWorkspacesRoute = createRoute({
  method: "post",
  path: "/workspace/closeAllWorkspaces",
  tags: ["Workspace"],
  summary: "Close all workspace folders",
  description:
    "Closes all currently open workspace folders in the workspace. This operation will trigger a workspace window reload.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: CloseWorkspacesResponseSchema,
        },
      },
      description: "Workspace folders closed successfully",
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

export function registerWorkspaceRoutes(app: OpenAPIHono) {
  // POST /api/v1/workspace/updateWorkspaceFolders - Update workspace folders
  app.openapi(updateWorkspaceFoldersRoute, async (c) => {
    try {
      const { folders } = await c.req.json();

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
        return c.json(
          {
            message: `Invalid folders: ${invalidFolders.join(", ")}`,
          },
          400,
        );
      }

      // Add the new workspace folders
      if (folders.length > 0) {
        // Convert string paths to workspace folders
        const workspaceFolderObjects = folders.map((folderPath: string) => ({
          uri: vscode.Uri.file(folderPath),
        }));

        const addSuccess = vscode.workspace.updateWorkspaceFolders(
          0,
          0,
          ...workspaceFolderObjects,
        );

        if (!addSuccess) {
          return c.json(
            {
              message: "Failed to add new workspace folders",
            },
            500,
          );
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

      const response = {
        message: `Successfully updated workspace folders. ${folders.length} folders added.`,
        workspaceFolders,
      };

      logger.info(`Workspace folders updated: added=${folders.length} folders`);

      return c.json(response, 200);
    } catch (error) {
      logger.error("Error updating workspace folders:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // POST /api/v1/workspace/closeAllWorkspaces - Close all workspace folders
  app.openapi(closeAllWorkspacesRoute, async (c) => {
    try {
      // Get current workspace folders count
      const currentWorkspaceFolders = vscode.workspace.workspaceFolders || [];
      const currentCount = currentWorkspaceFolders.length;

      if (currentCount === 0) {
        const response = {
          message: "No workspace folders to close",
        };
        return c.json(response, 200);
      }

      // Close all existing workspaces
      const closeSuccess = vscode.workspace.updateWorkspaceFolders(
        0,
        currentCount,
      );

      if (!closeSuccess) {
        return c.json(
          {
            message: "Failed to close workspace folders",
          },
          500,
        );
      }

      const response = {
        message: `Successfully closed ${currentCount} workspace folders`,
      };

      logger.info(`Closed ${currentCount} workspace folders`);
      return c.json(response, 200);
    } catch (error) {
      logger.error("Error closing workspace folders:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });
}
