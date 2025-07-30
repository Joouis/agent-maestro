import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "../../utils/logger";
import { readConfiguration } from "../../utils/config";
import { getMimeType } from "../utils/mimeTypes";
import {
  ErrorResponseSchema,
  FileReadRequestSchema,
  FileReadResponseSchema,
  FileWriteRequestSchema,
  FileWriteResponseSchema,
} from "../schemas";

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

// OpenAPI route definitions
const readFileRoute = createRoute({
  method: "post",
  path: "/fs/read",
  tags: ["FileSystem"],
  summary: "Read file content",
  description:
    "Reads the content of a file within the VS Code workspace. Returns text files as UTF-8 and binary files as base64-encoded data",
  request: {
    body: {
      content: {
        "application/json": {
          schema: FileReadRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: FileReadResponseSchema,
        },
      },
      description: "File content read successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - invalid path or access denied",
    },
    404: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "File not found",
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

const writeFileRoute = createRoute({
  method: "post",
  path: "/fs/write",
  tags: ["FileSystem"],
  summary: "Write file content",
  description:
    "Writes content to a file within the VS Code workspace. Supports both UTF-8 text and base64-encoded binary data",
  request: {
    body: {
      content: {
        "application/json": {
          schema: FileWriteRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: FileWriteResponseSchema,
        },
      },
      description: "File content written successfully",
    },
    400: {
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
      description: "Bad request - invalid path or access denied",
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

export function registerFsRoutes(app: OpenAPIHono) {
  // POST /api/v1/fs/read - Read file content
  app.openapi(readFileRoute, async (c) => {
    try {
      const { path: requestedPath } = await c.req.json();

      if (!requestedPath || requestedPath.trim() === "") {
        return c.json({ message: "File path is required" }, 400);
      }

      // Validate workspace path
      const validation = validateWorkspacePath(requestedPath);
      if (!validation.isValid) {
        return c.json({ message: validation.error ?? "" }, 400);
      }

      const resolvedPath = validation.resolvedPath!;

      try {
        // Check if file exists and get stats
        const stats = await fs.stat(resolvedPath);

        if (!stats.isFile()) {
          return c.json({ message: "Path does not point to a file" }, 400);
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

        const response = {
          path: requestedPath,
          content,
          encoding,
          size: stats.size,
          mimeType,
        };

        logger.info(
          `File read successfully: ${requestedPath} (${stats.size} bytes)`,
        );
        return c.json(response, 200);
      } catch (fileError: any) {
        if (fileError.code === "ENOENT") {
          return c.json({ message: "File not found" }, 404);
        } else if (fileError.code === "EACCES") {
          return c.json(
            { message: "Access denied: Insufficient permissions to read file" },
            400,
          );
        } else {
          throw fileError;
        }
      }
    } catch (error) {
      logger.error("Error reading file:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });

  // POST /api/v1/fs/write - Write file content
  app.openapi(writeFileRoute, async (c) => {
    try {
      const { path: requestedPath, content, encoding } = await c.req.json();

      if (!requestedPath || requestedPath.trim() === "") {
        return c.json({ message: "File path is required" }, 400);
      }

      if (content === undefined) {
        return c.json({ message: "File content is required" }, 400);
      }

      if (!encoding || (encoding !== "utf8" && encoding !== "base64")) {
        return c.json(
          { message: "Valid encoding (utf8 or base64) is required" },
          400,
        );
      }

      // Validate workspace path
      const validation = validateWorkspacePath(requestedPath);
      if (!validation.isValid) {
        return c.json({ message: validation.error ?? "" }, 400);
      }

      const resolvedPath = validation.resolvedPath!;

      try {
        // Create parent directories if they don't exist
        const parentDir = path.dirname(resolvedPath);
        await fs.mkdir(parentDir, { recursive: true });

        // Write file content with the specified encoding
        let buffer: Buffer;
        if (encoding === "base64") {
          buffer = Buffer.from(content, "base64");
        } else {
          buffer = Buffer.from(content, "utf8");
        }

        await fs.writeFile(resolvedPath, buffer);

        // Get file stats to return size
        const stats = await fs.stat(resolvedPath);

        const response = {
          path: requestedPath,
          size: stats.size,
        };

        logger.info(
          `File written successfully: ${requestedPath} (${stats.size} bytes)`,
        );
        return c.json(response, 200);
      } catch (fileError: any) {
        if (fileError.code === "EACCES") {
          return c.json(
            {
              message: "Access denied: Insufficient permissions to write file",
            },
            400,
          );
        } else {
          throw fileError;
        }
      }
    } catch (error) {
      logger.error("Error writing file:", error);
      const message =
        error instanceof Error ? error.message : "Unknown error occurred";
      return c.json({ message }, 500);
    }
  });
}
