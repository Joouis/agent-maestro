import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type * as vscode from "vscode";

import { chatModelsCache } from "../../../utils/chatModels";
import { logger } from "../../../utils/logger";

const modelSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number().int(),
  owned_by: z.string(),
});
const errorSchema = z.object({
  error: z.object({
    type: z.string(),
    message: z.string(),
    param: z.string().nullable(),
    code: z.string().nullable(),
  }),
});

const listModelsRoute = createRoute({
  method: "get",
  path: "/v1/models",
  tags: ["OpenAI API"],
  summary: "List proxy-eligible models",
  description:
    "List all Copilot models available for generation, including Grok, using the OpenAI Models response format.",
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
      description: "Available models",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Model discovery failed",
    },
  },
});

const retrieveModelRoute = createRoute({
  method: "get",
  path: "/v1/models/{model_id}",
  tags: ["OpenAI API"],
  summary: "Retrieve a proxy-eligible model",
  description:
    "Retrieve an exact model ID. Discovery does not perform fuzzy matching or fall back to another model.",
  request: { params: z.object({ model_id: z.string().min(1) }) },
  responses: {
    200: {
      content: { "application/json": { schema: modelSchema } },
      description: "Available model",
    },
    404: {
      content: { "application/json": { schema: errorSchema } },
      description: "Model not found",
    },
    500: {
      content: { "application/json": { schema: errorSchema } },
      description: "Model discovery failed",
    },
  },
});

function toOpenAIModel(model: vscode.LanguageModelChat) {
  return {
    id: model.id,
    object: "model" as const,
    // VS Code does not expose a creation timestamp or the underlying owner.
    created: 0,
    owned_by: model.vendor,
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
  app.openapi(listModelsRoute, async (c) => {
    try {
      const models = await getChatModels();
      return c.json(
        { object: "list" as const, data: models.map(toOpenAIModel) },
        200,
      );
    } catch (error) {
      logger.error("OpenAI model discovery failed:", error);
      return c.json(
        {
          error: {
            type: "api_error",
            message: "Failed to list available models",
            param: null,
            code: null,
          },
        },
        500,
      );
    }
  });
  app.openapi(retrieveModelRoute, async (c) => {
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
      return c.json(toOpenAIModel(model), 200);
    } catch (error) {
      logger.error("OpenAI model discovery failed:", error);
      return c.json(
        {
          error: {
            type: "api_error",
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
