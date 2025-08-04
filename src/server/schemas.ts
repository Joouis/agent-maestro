import { z } from "@hono/zod-openapi";

// ============================================================================
// COMMON SCHEMAS
// ============================================================================

export const ErrorResponseSchema = z
  .object({
    message: z.string().describe("Error message"),
  })
  .openapi("ErrorResponse");

export const AnthropicErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string().describe("Error message"),
      type: z.string().describe("Error type"),
    }),
    type: z.string().describe("Error type"),
  })
  .openapi("AnthropicErrorResponse");

// ============================================================================
// ANTHROPIC API SCHEMAS
// ============================================================================
export const AnthropicMessageCreateParamsSchema = z.looseObject({
  model: z.string().describe("The model to use for the request"),
  messages: z
    .array(
      z.looseObject({
        role: z
          .enum(["user", "assistant"])
          .describe("The role of the message sender"),
        content: z
          .union([
            z.string(),
            z.array(
              z.union([
                z.looseObject({
                  type: z.literal("text"),
                  text: z.string(),
                }),
                z.looseObject({
                  type: z.literal("image"),
                  source: z.looseObject({
                    type: z.literal("base64"),
                    media_type: z.string(),
                    data: z.string(),
                  }),
                }),
                z.looseObject({
                  type: z.literal("tool_use"),
                  id: z.string(),
                  name: z.string(),
                  input: z.looseObject({}),
                }),
                z.looseObject({
                  type: z.literal("tool_result"),
                  tool_use_id: z.string(),
                  content: z.union([z.string(), z.array(z.any())]).optional(),
                  is_error: z.boolean().optional(),
                }),
              ]),
            ),
          ])
          .describe("The content of the message"),
      }),
    )
    .describe("Array of conversation messages"),
  system: z
    .union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.literal("text"),
          text: z.string(),
          cache_control: z
            .looseObject({
              type: z.literal("ephemeral"),
            })
            .optional(),
        }),
      ),
    ])
    .optional()
    .describe("System message to guide the assistant"),
  max_tokens: z
    .number()
    .min(1)
    .optional()
    .describe("Maximum number of tokens to generate"),
  metadata: z
    .looseObject({
      user_id: z.string().optional(),
    })
    .optional()
    .describe("Metadata for the request"),
  stop_sequences: z
    .array(z.string())
    .optional()
    .describe(
      "Custom text sequences that will cause the model to stop generating",
    ),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Controls randomness in responses (0.0 to 1.0)"),
  top_k: z
    .number()
    .min(1)
    .optional()
    .describe("Only sample from the top K options for each subsequent token"),
  top_p: z.number().min(0).max(1).optional().describe("Use nucleus sampling"),
  stream: z.boolean().optional().describe("Whether to stream the response"),
  tools: z
    .array(
      z.looseObject({
        name: z.string().describe("The name of the tool"),
        description: z
          .string()
          .optional()
          .describe("Description of what the tool does"),
        input_schema: z
          .record(z.string(), z.any())
          // "web_search" tool does not meet the schema, so we make it optional
          .optional()
          .describe("JSON schema for the tool input"),
        cache_control: z
          .looseObject({
            type: z.literal("ephemeral"),
          })
          .optional(),
      }),
    )
    .optional()
    .describe("Available tools for the model"),
  tool_choice: z
    .union([
      z.looseObject({
        type: z.literal("auto"),
      }),
      z.looseObject({
        type: z.literal("any"),
      }),
      z.looseObject({
        type: z.literal("tool"),
        name: z.string(),
      }),
    ])
    .optional()
    .describe("Tool choice configuration"),
});

export const AnthropicMessageResponseSchema = z.looseObject({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.any()),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().nullable(),
    cache_read_input_tokens: z.number().nullable(),
    server_tool_use: z.any().nullable(),
    service_tier: z.string().nullable(),
  }),
});

export const AnthropicCountTokensResponseSchema = z.object({
  input_tokens: z.number().describe("Number of input tokens"),
});

// ============================================================================
// CLINE API SCHEMAS
// ============================================================================
export const ClineMessageRequestSchema = z.object({
  text: z.string().min(1).describe("The task description to execute"),
  images: z
    .array(z.string())
    .optional()
    .describe("Optional array of base64-encoded images"),
});

export const ClineTaskResponseSchema = z.object({
  id: z.string().describe("Unique task identifier"),
  status: z
    .enum(["created", "running", "completed", "failed"])
    .describe("Current task status"),
  message: z.string().describe("Status message"),
});

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
// ROOCODE API SCHEMAS
// ============================================================================
export const RooMessageRequestSchema = z.object({
  text: z.string().min(1).describe("The task query text"),
  images: z
    .array(z.string())
    .optional()
    .describe("Optional array of image URLs or base64 encoded images"),
  configuration: z
    .record(z.string(), z.any())
    .optional()
    .describe("RooCode configuration settings"),
  newTab: z
    .boolean()
    .optional()
    .describe("Whether to open the task in a new tab"),
  extensionId: z
    .string()
    .optional()
    .describe("Assign task to the Roo variant extension like Kilo Code"),
});

export const RooActionRequestSchema = z.object({
  action: z
    .enum(["pressPrimaryButton", "pressSecondaryButton", "cancel", "resume"])
    .describe("The action to perform on the task"),
  extensionId: z
    .string()
    .optional()
    .describe("Assign task to the Roo variant extension like Kilo Code"),
});

export const HistoryItemSchema = z.object({
  id: z.string().describe("Task ID"),
  number: z.number().optional().describe("Task number"),
  ts: z.number().describe("Timestamp"),
  task: z.string().describe("Task description"),
  tokensIn: z.number().describe("Input tokens used"),
  tokensOut: z.number().describe("Output tokens used"),
  cacheWrites: z.number().optional().describe("Cache writes"),
  cacheReads: z.number().optional().describe("Cache reads"),
  totalCost: z.number().describe("Total cost"),
  size: z.number().optional().describe("Task size"),
  workspace: z.string().optional().describe("Workspace path"),
});

export const RooTaskResponseSchema = z.object({
  id: z.string().describe("Task identifier"),
  status: z
    .enum(["created", "running", "completed", "failed"])
    .describe("Task status"),
  message: z.string().describe("Status message"),
});

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
