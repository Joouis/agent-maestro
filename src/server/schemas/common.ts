import { z } from "@hono/zod-openapi";

// ============================================================================
// COMMON SCHEMAS
// ============================================================================

export const ErrorResponseSchema = z
  .object({
    message: z.string().describe("Error message"),
  })
  .openapi("ErrorResponse");

// ============================================================================
// FILE SYSTEM SCHEMAS
// ============================================================================

export const FileReadRequestSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path relative to VS Code workspace root"),
});

export const FileReadResponseSchema = z.object({
  path: z.string().describe("The file path that was read"),
  content: z
    .string()
    .describe("File content (UTF-8 for text files, base64 for binary files)"),
  encoding: z
    .string()
    .describe(
      "Content encoding (utf8 for text files, base64 for binary files)",
    ),
  size: z.number().describe("File size in bytes"),
  mimeType: z.string().describe("Detected MIME type"),
});

export const FileWriteRequestSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("File path relative to VS Code workspace root"),
  content: z
    .string()
    .describe("File content to write (UTF-8 text or base64-encoded binary)"),
  encoding: z
    .enum(["utf8", "base64"])
    .describe("Content encoding (utf8 for text, base64 for binary)"),
});

export const FileWriteResponseSchema = z.object({
  path: z.string().describe("The file path that was written"),
  size: z.number().describe("Size of the written file in bytes"),
});

// ============================================================================
// SYSTEM INFORMATION SCHEMAS
// ============================================================================

export const ExtensionInfoSchema = z.object({
  isInstalled: z.boolean().describe("Whether the extension is installed"),
  isActive: z.boolean().describe("Whether the extension is active"),
  version: z.string().optional().describe("Extension version if available"),
});

export const OSInfoSchema = z.object({
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

export const SystemInfoSchema = z.object({
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
