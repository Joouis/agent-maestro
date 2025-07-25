import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import * as vscode from "vscode";
import { LanguageModelToolInformation } from "vscode";
import { logger } from "../../utils/logger";

const registerSchemas = (fastify: FastifyInstance) => {
  fastify.addSchema({
    $id: "ChatModelsResponse",
    type: "array",
    items: {
      type: "object",
      properties: {
        capabilities: {
          type: "object",
          properties: {
            supportsImageToText: { type: "boolean" },
            supportsToolCalling: { type: "boolean" },
          },
          additionalProperties: true,
        },
        family: { type: "string" },
        id: { type: "string" },
        maxInputTokens: { type: "number" },
        name: { type: "string" },
        vendor: { type: "string" },
        version: { type: "string" },
      },
      additionalProperties: true,
      description: "vscode.LanguageModelChat interface without methods",
    },
    description: "Array of available chat models",
  });

  fastify.addSchema({
    $id: "ToolsResponse",
    type: "array",
    items: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "A unique name for the tool",
        },
        description: {
          type: "string",
          description:
            "A description of this tool that may be passed to a language model",
        },
        inputSchema: {
          type: ["object", "null"],
          additionalProperties: true,
          description: "A JSON schema for the input this tool accepts",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "A set of tags that roughly describe the tool's capabilities",
        },
      },
      required: ["name", "description", "tags"],
      additionalProperties: false,
      description: "vscode.LanguageModelToolInformation interface",
    },
    description: "Array of available language model tools",
  });
};

export async function registerLmRoutes(fastify: FastifyInstance) {
  registerSchemas(fastify);

  // GET /api/v1/lm/chatModels - List all available chat models
  fastify.get(
    "/lm/chatModels",
    {
      schema: {
        tags: ["Language Models"],
        summary: "List available chat models",
        description:
          "Retrieves all available language models from VSCode's language model API. Models may support various capabilities like image-to-text conversion and tool calling.",
        response: {
          200: {
            description: "Successfully retrieved chat models",
            $ref: "ChatModelsResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        logger.info("Fetching available chat models from VSCode LM API");

        // Get all available chat models from VSCode
        const models = (await vscode.lm.selectChatModels({})) || [];

        logger.info(`Retrieved ${models.length} chat models`);
        return reply.send(models);
      } catch (error) {
        logger.error("Error fetching chat models:", error);
        return reply.status(500).send({
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch chat models",
        });
      }
    },
  );

  // GET /api/v1/lm/tools - List all available language model tools
  fastify.get(
    "/lm/tools",
    {
      schema: {
        tags: ["Language Models"],
        summary: "List available language model tools",
        description:
          "Retrieves all available language model tools registered by extensions using lm.registerTool. Tools provide specific capabilities that language models can invoke to perform tasks.",
        response: {
          200: {
            description: "Successfully retrieved language model tools",
            $ref: "ToolsResponse#",
          },
          500: {
            description: "Internal server error",
            $ref: "ErrorResponse#",
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        logger.info(
          "Fetching available language model tools from VSCode LM API",
        );

        // Get all available tools from VSCode
        const tools: readonly LanguageModelToolInformation[] =
          vscode.lm.tools || [];

        logger.info(`Retrieved ${tools.length} language model tools`);
        return reply.send(tools);
      } catch (error) {
        logger.error("Error fetching language model tools:", error);
        return reply.status(500).send({
          message:
            error instanceof Error
              ? error.message
              : "Failed to fetch language model tools",
        });
      }
    },
  );
}
