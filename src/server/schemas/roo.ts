import { z } from "@hono/zod-openapi";

import { ImagesDataUriSchema } from "./cline.js";

export const ProviderSettingsSchema = z
  .object({
    apiProvider: z
      .enum([
        "anthropic",
        "openai",
        "bedrock",
        "vertex",
        "ollama",
        "gemini",
        "openrouter",
        "deepseek",
        "mistral",
        "groq",
        "fireworks",
        "glama",
        "vscode-lm",
        "lmstudio",
        "openai-native",
        "unbound",
        "requesty",
        "human-relay",
        "fake-ai",
        "xai",
        "chutes",
        "litellm",
        "kilocode",
      ])
      .optional(),
    apiKey: z.string().optional(),
    apiModelId: z.string().optional(),
    modelTemperature: z.number().optional(),
    modelMaxTokens: z.number().optional(),
    modelMaxThinkingTokens: z.number().optional(),
    includeMaxTokens: z.boolean().optional(),
    reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
    diffEnabled: z.boolean().optional(),
    fuzzyMatchThreshold: z.number().optional(),
    rateLimitSeconds: z.number().optional(),
    // Add other provider-specific fields as needed
  })
  .openapi("ProviderSettings");

export const ProviderSettingsEntrySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    apiProvider: z.string().optional(),
  })
  .openapi("ProviderSettingsEntry");

export const CreateProfileRequestSchema = z
  .object({
    name: z.string().min(1).describe("Profile name"),
    profile: ProviderSettingsSchema.optional().describe("Provider settings"),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Activate profile after creation"),
    extensionId: z.string().optional().describe("Target extension ID"),
  })
  .openapi("CreateProfileRequest");

export const UpdateProfileRequestSchema = z
  .object({
    profile: ProviderSettingsSchema.describe("Updated provider settings"),
    activate: z
      .boolean()
      .optional()
      .default(true)
      .describe("Activate profile after update"),
    extensionId: z.string().optional().describe("Target extension ID"),
  })
  .openapi("UpdateProfileRequest");

export const SetActiveProfileRequestSchema = z
  .object({
    extensionId: z.string().optional().describe("Target extension ID"),
  })
  .openapi("SetActiveProfileRequest");

export const ProfileResponseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    profile: ProviderSettingsSchema,
    isActive: z.boolean(),
  })
  .openapi("ProfileResponse");

export const RooMessageRequestSchema = z.object({
  text: z.string().min(1).describe("The task query text"),
  images: ImagesDataUriSchema,
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
