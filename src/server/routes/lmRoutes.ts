import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as vscode from "vscode";
import { LanguageModelToolInformation } from "vscode";
import { logger } from "../../utils/logger";
import { ErrorResponseSchema } from "../schemas";

// Zod schemas for validation and OpenAPI documentation
const ChatModelCapabilitiesSchema = z
  .object({
    supportsImageToText: z
      .boolean()
      .describe("Whether the model supports image-to-text conversion"),
    supportsToolCalling: z
      .boolean()
      .describe("Whether the model supports tool calling"),
  })
  .loose(); // Allow additional properties

const ChatModelSchema = z
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

const ChatModelsResponseSchema = z
  .array(ChatModelSchema)
  .describe("Array of available chat models");

const LanguageModelToolSchema = z.object({
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

const ToolsResponseSchema = z
  .array(LanguageModelToolSchema)
  .describe("Array of available language model tools");

// OpenAPI route definitions
const chatModelsRoute = createRoute({
  method: "get",
  path: "/lm/chatModels",
  tags: ["Language Models"],
  summary: "List available chat models",
  description:
    "Retrieves all available language models from VSCode's language model API. Models may support various capabilities like image-to-text conversion and tool calling.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ChatModelsResponseSchema,
        },
      },
      description: "Successfully retrieved chat models",
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

const toolsRoute = createRoute({
  method: "get",
  path: "/lm/tools",
  tags: ["Language Models"],
  summary: "List available language model tools",
  description:
    "Retrieves all available language model tools registered by extensions using lm.registerTool. Tools provide specific capabilities that language models can invoke to perform tasks.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: ToolsResponseSchema,
        },
      },
      description: "Successfully retrieved language model tools",
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

export function registerLmRoutes(app: OpenAPIHono) {
  // GET /api/v1/lm/chatModels - List all available chat models
  app.openapi(chatModelsRoute, async (c) => {
    try {
      logger.info("Fetching available chat models from VSCode LM API");

      // Get all available chat models from VSCode
      const models = (await vscode.lm.selectChatModels({})) || [];

      logger.info(`Retrieved ${models.length} chat models`);
      return c.json(ChatModelsResponseSchema.parse(models), 200);
    } catch (error) {
      logger.error("Error fetching chat models:", error);
      const message =
        error instanceof Error ? error.message : "Failed to fetch chat models";
      return c.json({ message }, 500);
    }
  });

  // GET /api/v1/lm/tools - List all available language model tools
  app.openapi(toolsRoute, async (c) => {
    try {
      logger.info("Fetching available language model tools from VSCode LM API");

      // Get all available tools from VSCode
      const tools: readonly LanguageModelToolInformation[] =
        vscode.lm.tools || [];

      logger.info(`Retrieved ${tools.length} language model tools`);
      return c.json(tools, 200);
    } catch (error) {
      logger.error("Error fetching language model tools:", error);
      const message =
        error instanceof Error
          ? error.message
          : "Failed to fetch language model tools";
      return c.json({ message }, 500);
    }
  });
}
