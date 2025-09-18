import { z } from "@hono/zod-openapi";

// ============================================================================
// LANGUAGE MODEL SCHEMAS
// ============================================================================

export const ChatModelCapabilitiesSchema = z
  .object({
    supportsImageToText: z
      .boolean()
      .describe("Whether the model supports image-to-text conversion"),
    supportsToolCalling: z
      .boolean()
      .describe("Whether the model supports tool calling"),
  })
  .loose(); // Allow additional properties

export const ChatModelSchema = z
  .object({
    capabilities: ChatModelCapabilitiesSchema.describe("Model capabilities"),
    family: z.string().describe("Model family name"),
    id: z.string().describe("Unique model identifier"),
    maxInputTokens: z.number().describe("Maximum input tokens supported"),
    name: z.string().describe("Human-readable model name"),
    vendor: z.string().describe("Model vendor/provider"),
    version: z.string().describe("Model version"),
  })
  .loose(); // Allow additional properties for VSCode interface compatibility

export const ChatModelsResponseSchema = z
  .array(ChatModelSchema)
  .describe("Array of available chat models");

export const LanguageModelToolSchema = z.object({
  name: z.string().describe("A unique name for the tool"),
  description: z
    .string()
    .describe(
      "A description of this tool that may be passed to a language model",
    ),
  inputSchema: z
    .record(z.string(), z.any())
    .nullable()
    .describe("A JSON schema for the input this tool accepts"),
  tags: z
    .array(z.string())
    .describe("A set of tags that roughly describe the tool's capabilities"),
});

export const ToolsResponseSchema = z
  .array(LanguageModelToolSchema)
  .describe("Array of available language model tools");

// ============================================================================
// WORKSPACE SCHEMAS
// ============================================================================

export const WorkspaceFolderSchema = z.object({
  uri: z.string().describe("Workspace folder URI"),
  name: z.string().describe("Workspace folder name"),
  index: z.number().describe("Index in workspace folders list"),
});

export const WorkspaceUpdateRequestSchema = z.object({
  folders: z
    .array(z.string())
    .min(1)
    .describe("Array of absolute paths for workspace folders to add"),
});

export const WorkspaceUpdateResponseSchema = z.object({
  message: z.string().describe("Status message"),
  workspaceFolders: z
    .array(WorkspaceFolderSchema)
    .describe("Current workspace folders after update"),
});

export const CloseWorkspacesResponseSchema = z.object({
  message: z.string().describe("Status message"),
});
