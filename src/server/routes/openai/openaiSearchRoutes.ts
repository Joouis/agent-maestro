import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ResponseInput } from "openai/resources/responses/responses";
import * as vscode from "vscode";

import {
  getChatModelClient,
  getCopilotModelConfiguration,
  isGpt5PlusModel,
  withCopilotConfiguration,
} from "../../../utils/chatModels";
import { readConfiguration } from "../../../utils/config";
import {
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER,
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
} from "../../../utils/copilotWebSearchConstants";
import { logger } from "../../../utils/logger";
import { CommonResponseError } from "../../schemas/openai";
import { handleErrorWithLogging } from "../../utils/errorDiagnostics";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  LanguageModelRequestTimeoutError,
  interruptibleLanguageModelStream,
} from "../../utils/languageModelRequestLifecycle";
import { convertResponsesInputToVSCode } from "../../utils/openaiResponses";

type SearchRequest = {
  id?: string;
  model?: string;
  input?: string | ResponseInput;
  commands?: Record<string, unknown>;
  settings?: {
    search_context_size?: unknown;
    user_location?: unknown;
  };
  reasoning?: { effort?: unknown };
};

const searchRoute = createRoute({
  method: "post",
  path: "/v1/alpha/search",
  tags: ["OpenAI API"],
  summary: "Run a Codex standalone web search",
  description:
    "Executes Codex standalone web-search commands through the experimental Copilot hosted web-search patch.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object()
            .describe("Codex standalone web-search request body."),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object()
            .describe("Codex standalone web-search response body."),
        },
      },
      description: "Search completed",
    },
    400: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Invalid request or web search is disabled",
    },
    404: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Model not found",
    },
    500: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Internal server error",
    },
    504: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Language model request timed out",
    },
  },
});

export interface OpenaiSearchRoutesOptions {
  requestTimeoutMs?: number;
  resolveChatModelClient?: typeof getChatModelClient;
  isExperimentalWebSearchEnabled?: () => boolean;
}

export function registerOpenaiSearchRoutes(
  app: OpenAPIHono,
  options: OpenaiSearchRoutesOptions = {},
) {
  const resolveChatModelClient =
    options.resolveChatModelClient ?? getChatModelClient;
  const isExperimentalWebSearchEnabled =
    options.isExperimentalWebSearchEnabled ??
    (() => readConfiguration().experimentalGpt5PlusWebSearchEnabled);

  app.openAPIRegistry.registerPath(searchRoute);
  app.post(searchRoute.path, async (c) => {
    let requestBody: SearchRequest | undefined;
    let messages: vscode.LanguageModelChatMessage[] | undefined;
    let requestedModelId = "";
    let lifecycle: LanguageModelRequestLifecycle | undefined;

    try {
      requestBody = (await c.req.json()) as SearchRequest;
      requestedModelId = requestBody.model ?? "";

      if (!requestBody.model) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "model is required",
              param: "model",
              code: "missing_required_parameter",
            },
          },
          400,
        );
      }
      if (
        !requestBody.commands ||
        Object.keys(requestBody.commands).length === 0
      ) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "commands is required",
              param: "commands",
              code: "missing_required_parameter",
            },
          },
          400,
        );
      }
      if (!isExperimentalWebSearchEnabled()) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message:
                "Enable the experimental GPT-5+ web search patch before using standalone search",
              param: null,
              code: "web_search_disabled",
            },
          },
          400,
        );
      }

      const { client, error: clientError } = await resolveChatModelClient(
        requestBody.model,
      );
      if (clientError) {
        return c.json(clientError, 404);
      }
      if (!isGpt5PlusModel(requestBody.model, client)) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Standalone web search requires a GPT-5+ Copilot model",
              param: "model",
              code: "unsupported_model",
            },
          },
          400,
        );
      }

      messages = convertResponsesInputToVSCode(requestBody.input);
      messages.push(
        vscode.LanguageModelChatMessage.User(
          "Execute this web-search command and return the useful results with their source URLs:\n" +
            JSON.stringify(requestBody.commands),
        ),
      );

      const webSearchTool = {
        type: "web_search",
        ...(requestBody.settings?.search_context_size !== undefined
          ? {
              search_context_size: requestBody.settings.search_context_size,
            }
          : {}),
        ...(requestBody.settings?.user_location !== undefined
          ? { user_location: requestBody.settings.user_location }
          : {}),
      };
      const sentinelTool: vscode.LanguageModelChatTool = {
        name: AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
        description: "Internal Agent Maestro standalone web-search marker.",
        inputSchema: {
          type: "object",
          properties: {
            [AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER]: {
              const: webSearchTool,
            },
          },
        },
      };
      const requestOptions: vscode.LanguageModelChatRequestOptions = {
        justification: "Codex standalone web-search endpoint",
        tools: [sentinelTool],
        toolMode: vscode.LanguageModelChatToolMode.Required,
      };

      lifecycle = new LanguageModelRequestLifecycle(
        c.req.raw.signal,
        options.requestTimeoutMs,
      );
      logger.info(`→ /v1/alpha/search | model: ${requestBody.model}`);
      const response = await lifecycle.waitFor(
        client.sendRequest(
          messages,
          withCopilotConfiguration(
            client,
            requestOptions,
            getCopilotModelConfiguration({
              reasoningEffort: requestBody.reasoning?.effort,
            }),
          ),
          lifecycle.token,
        ),
      );

      let output = "";
      for await (const chunk of interruptibleLanguageModelStream(
        response.stream,
        lifecycle,
      )) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          output += chunk.value;
        }
      }

      logger.info(`← /v1/alpha/search | chars: ${output.length}`);
      return c.json({ output });
    } catch (error) {
      if (error instanceof LanguageModelRequestTimeoutError) {
        logger.error("✕ /v1/alpha/search |", error);
        return c.json(
          {
            error: {
              type: "timeout_error",
              message: error.message,
              param: null,
              code: "request_timeout",
            },
          },
          504,
        );
      }
      if (error instanceof LanguageModelClientDisconnectedError) {
        logger.info("/v1/alpha/search | client disconnected");
        return c.json(
          {
            error: {
              type: "client_disconnected",
              message: error.message,
              param: null,
              code: "client_disconnected",
            },
          },
          500,
        );
      }

      logger.error("✕ /v1/alpha/search |", error);
      const logFilePath = await handleErrorWithLogging({
        requestBody,
        inputTokens: 0,
        lmChatMessages: messages,
        error,
        endpoint: "/api/openai/v1/alpha/search",
        modelId: requestedModelId,
      });
      return c.json(
        {
          error: {
            type: "internal_error",
            message:
              error instanceof Error ? error.message : "Internal server error",
            param: null,
            code: null,
            log_file: logFilePath,
          },
        },
        500,
      );
    } finally {
      lifecycle?.dispose();
    }
  });
}
