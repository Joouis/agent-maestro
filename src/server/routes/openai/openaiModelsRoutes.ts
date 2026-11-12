import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Model } from "openai/resources/models";
import type * as vscode from "vscode";

import { chatModelsCache } from "../../../utils/chatModels";
import { logger } from "../../../utils/logger";
import { CommonResponseError } from "../../schemas/openai";

const modelSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number().int(),
  owned_by: z.string(),
});

const modelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  tags: ["OpenAI API"],
  summary: "List OpenAI-compatible models",
  description:
    "List proxy-eligible Copilot models using the OpenAI Models response format.",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            object: z.literal("list"),
            data: z.array(modelSchema),
          }),
        },
      },
      description: "Successfully listed models",
    },
    500: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Internal server error",
    },
  },
});

const modelRoute = createRoute({
  method: "get",
  path: "/v1/models/{model_id}",
  tags: ["OpenAI API"],
  summary: "Retrieve an OpenAI-compatible model",
  description:
    "Retrieve an exact model ID. Discovery does not perform fuzzy matching or fall back to another model.",
  request: {
    params: z.object({
      model_id: z.string().min(1).describe("Model identifier"),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: modelSchema } },
      description: "Successfully retrieved model",
    },
    404: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Model not found",
    },
    500: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Internal server error",
    },
  },
});

function convertVSCodeModelToOpenAIModel(
  model: vscode.LanguageModelChat,
): Model {
  return {
    id: model.id,
    object: "model" as const,
    // VS Code does not expose a creation timestamp or the underlying owner.
    created: 0,
    owned_by: "copilot",
  };
}

export interface OpenaiModelsRoutesOptions {
  getChatModels?: () => Promise<vscode.LanguageModelChat[]>;
}

export function registerOpenaiModelsRoutes(
  app: OpenAPIHono,
  options: OpenaiModelsRoutesOptions = {},
): void {
  const getChatModels =
    options.getChatModels ??
    (() => chatModelsCache.getChatModels({ throwOnError: true }));
  app.openapi(modelsRoute, async (c) => {
    try {
      const models = await getChatModels();
      return c.json(
        {
          object: "list" as const,
          data: models.map(convertVSCodeModelToOpenAIModel),
        },
        200,
      );
    } catch (error) {
      logger.error("Error fetching OpenAI-compatible models:", error);
      return c.json(
        {
          error: {
            type: "internal_error",
            message: "Failed to list available models",
            param: null,
            code: null,
          },
        },
        500,
      );
    }
  });
  app.openapi(modelRoute, async (c) => {
    const { model_id: modelId } = c.req.valid("param");
    try {
      const models = await getChatModels();
      const model = models.find((entry) => entry.id === modelId);
      if (!model) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: `Model '${modelId}' not found`,
              param: "model",
              code: "model_not_found",
            },
          },
          404,
        );
      }
      return c.json(convertVSCodeModelToOpenAIModel(model), 200);
    } catch (error) {
      logger.error("Error fetching OpenAI-compatible model:", error);
      return c.json(
        {
          error: {
            type: "internal_error",
            message: "Failed to retrieve available model",
            param: null,
            code: null,
          },
        },
        500,
      );
    }
  });
}
