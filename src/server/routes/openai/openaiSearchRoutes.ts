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

const SearchSettingsSchema = z
  .object({
    search_context_size: z.enum(["low", "medium", "high"]).optional(),
    user_location: z
      .object({
        type: z.literal("approximate"),
        country: z.string().optional(),
        region: z.string().optional(),
        city: z.string().optional(),
        timezone: z.string().optional(),
      })
      .optional(),
    filters: z
      .object({
        allowed_domains: z.array(z.string()).optional(),
        blocked_domains: z.array(z.string()).optional(),
      })
      .optional(),
    external_web_access: z
      .union([z.boolean(), z.enum(["cached", "indexed", "live"])])
      .optional(),
  })
  .passthrough();

const SearchRequestSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.unknown())]).optional() as z.ZodType<
      string | ResponseInput | undefined
    >,
    commands: z.record(z.string(), z.unknown()),
    settings: SearchSettingsSchema.optional(),
    reasoning: z
      .object({ effort: z.string().optional() })
      .passthrough()
      .optional(),
    max_output_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

type SearchRequest = z.infer<typeof SearchRequestSchema>;

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
          schema: SearchRequestSchema.describe(
            "Codex standalone web-search request body.",
          ),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({ output: z.string() })
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
      let rawRequestBody: unknown;
      try {
        rawRequestBody = await c.req.json();
      } catch {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "Request body must be valid JSON",
              param: null,
              code: "invalid_json",
            },
          },
          400,
        );
      }

      const parsedRequest = SearchRequestSchema.safeParse(rawRequestBody);
      if (!parsedRequest.success) {
        const issue = parsedRequest.error.issues[0];
        const param = issue?.path.join(".") || null;
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: issue?.message ?? "Invalid request body",
              param,
              code: "invalid_request",
            },
          },
          400,
        );
      }
      requestBody = parsedRequest.data;
      requestedModelId = requestBody.model;
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
      if (requestBody.settings?.external_web_access === undefined) {
        return c.json(
          {
            error: {
              type: "invalid_request_error",
              message: "settings.external_web_access is required",
              param: "settings.external_web_access",
              code: "missing_required_parameter",
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
      if (!isGpt5PlusModel("", client)) {
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
        external_web_access:
          requestBody.settings.external_web_access === true ||
          requestBody.settings.external_web_access === "live" ||
          requestBody.settings.external_web_access === "indexed",
        ...(requestBody.settings.external_web_access === "indexed"
          ? { indexed_web_access: true }
          : {}),
        ...(requestBody.settings?.search_context_size !== undefined
          ? {
              search_context_size: requestBody.settings.search_context_size,
            }
          : {}),
        ...(requestBody.settings?.user_location !== undefined
          ? { user_location: requestBody.settings.user_location }
          : {}),
        ...(requestBody.settings?.filters !== undefined
          ? { filters: requestBody.settings.filters }
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
        modelOptions:
          typeof requestBody.max_output_tokens === "number"
            ? { maxTokens: requestBody.max_output_tokens }
            : undefined,
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
