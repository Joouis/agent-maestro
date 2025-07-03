import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import { readConfiguration } from "../../utils/config";
import { FileReadRequest, FileReadResponse } from "../types";
import { getMimeType } from "../utils/mimeTypes";

// Validate that the path is within the workspace
function validateWorkspacePath(requestedPath: string): {
  isValid: boolean;
  error?: string;
  resolvedPath?: string;
} {
  try {
    // Get workspace root
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return {
        isValid: false,
        error: "No workspace is currently open",
      };
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // Resolve the requested path relative to workspace root
    const resolvedPath = path.resolve(workspaceRoot, requestedPath);

    // Check if the resolved path is within the workspace
    const config = readConfiguration();
    if (!config.allowOutsideWorkspaceAccess) {
      const relativePath = path.relative(workspaceRoot, resolvedPath);
      if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        return {
          isValid: false,
          error:
            "Access denied: Path is outside workspace boundaries. Enable 'allowOutsideWorkspaceAccess' in settings to access files outside the workspace.",
        };
      }
    }

    // Additional security checks for sensitive files
    const sensitivePatterns = [
      /\.env$/,
      /\.key$/,
      /\.pem$/,
      /\.p12$/,
      /\.pfx$/,
      /password/i,
      /secret/i,
    ];

    const fileName = path.basename(resolvedPath);
    if (sensitivePatterns.some((pattern) => pattern.test(fileName))) {
      return {
        isValid: false,
        error: "Access denied: Cannot read sensitive files",
      };
    }

    return {
      isValid: true,
      resolvedPath,
    };
  } catch (error) {
    return {
      isValid: false,
      error: `Path validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export async function registerFsRoutes(fastify: FastifyInstance) {
  // POST /api/v1/fs/read - Read file content
  fastify.post(
    "/fs/read",
    {
      schema: {
        tags: ["FileSystem"],
        summary: "Read file content",
        description:
          "Reads the content of a file within the VS Code workspace. Returns text files as UTF-8 and binary files as base64-encoded data",
        body: { $ref: "FileReadRequest#" },
        response: {
          200: {
            description: "File content read successfully",
            $ref: "FileReadResponse#",
          },
          400: {
            description: "Bad request - invalid path or access denied",
            $ref: "ErrorResponse#",
          },
          404: {
            description: "File not found",
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
        const { path: requestedPath } = request.body as FileReadRequest;

        if (!requestedPath || requestedPath.trim() === "") {
          return reply.status(400).send({
            message: "File path is required",
          });
        }

        // Validate workspace path
        const validation = validateWorkspacePath(requestedPath);
        if (!validation.isValid) {
          return reply.status(400).send({
            message: validation.error,
          });
        }

        const resolvedPath = validation.resolvedPath!;

        try {
          // Check if file exists and get stats
          const stats = await fs.stat(resolvedPath);

          if (!stats.isFile()) {
            return reply.status(400).send({
              message: "Path does not point to a file",
            });
          }

          // Read file content
          const buffer = await fs.readFile(resolvedPath);
          const mimeType = getMimeType(resolvedPath);

          // Determine if file is text or binary based on MIME type
          const isTextFile =
            mimeType.startsWith("text/") ||
            mimeType === "application/json" ||
            mimeType === "application/javascript" ||
            mimeType === "application/typescript" ||
            mimeType === "application/xml" ||
            mimeType === "application/yaml" ||
            mimeType === "application/sql";

          let content: string;
          let encoding: string;

          if (isTextFile) {
            // For text files, return UTF-8 content directly
            content = buffer.toString("utf8");
            encoding = "utf8";
          } else {
            // For binary files, return base64-encoded content
            content = buffer.toString("base64");
            encoding = "base64";
          }

          const response: FileReadResponse = {
            path: requestedPath,
            content,
            encoding,
            size: stats.size,
            mimeType,
          };

          logger.info(
            `File read successfully: ${requestedPath} (${stats.size} bytes)`,
          );
          return reply.send(response);
        } catch (fileError: any) {
          if (fileError.code === "ENOENT") {
            return reply.status(404).send({
              message: "File not found",
            });
          } else if (fileError.code === "EACCES") {
            return reply.status(400).send({
              message: "Access denied: Insufficient permissions to read file",
            });
          } else {
            throw fileError;
          }
        }
      } catch (error) {
        logger.error("Error reading file:", error);
        return reply.status(500).send({
          message:
            error instanceof Error ? error.message : "Unknown error occurred",
        });
      }
    },
  );
}
