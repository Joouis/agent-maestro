import * as vscode from "vscode";

import { logger } from "../../../utils/logger";
import { BraveSearchProvider } from "./providers/brave";
import { TavilyProvider } from "./providers/tavily";
import { WebSearchProvider } from "./types";

export type {
  WebSearchProvider,
  WebSearchResult,
  WebSearchOptions,
} from "./types";

export interface WebSearchConfig {
  enabled: boolean;
  provider: "tavily" | "brave";
  apiKey: string;
  maxResults: number;
  maxUsesPerRequest: number;
  timeoutMs: number;
}

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  enabled: false,
  provider: "tavily",
  apiKey: "",
  maxResults: 5,
  maxUsesPerRequest: 5,
  timeoutMs: 8000,
};

const SUPPORTED_PROVIDERS = ["tavily", "brave"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const isSupportedProvider = (v: unknown): v is SupportedProvider =>
  typeof v === "string" &&
  (SUPPORTED_PROVIDERS as readonly string[]).includes(v);

export const getWebSearchConfig = (): WebSearchConfig => {
  const cfg = vscode.workspace.getConfiguration("agent-maestro.webSearch");
  const apiKey =
    process.env.AGENT_MAESTRO_WEBSEARCH_API_KEY ||
    cfg.get<string>("apiKey", "");

  const settingProvider = cfg.get<string>(
    "provider",
    DEFAULT_WEB_SEARCH_CONFIG.provider,
  );
  const envProviderRaw = process.env.AGENT_MAESTRO_WEBSEARCH_PROVIDER;
  let provider: SupportedProvider;
  if (envProviderRaw !== undefined) {
    if (isSupportedProvider(envProviderRaw)) {
      provider = envProviderRaw;
    } else {
      logger.warn(
        `Ignoring AGENT_MAESTRO_WEBSEARCH_PROVIDER='${envProviderRaw}' (not one of ${SUPPORTED_PROVIDERS.join(
          "/",
        )}); falling back to setting`,
      );
      provider = isSupportedProvider(settingProvider)
        ? settingProvider
        : DEFAULT_WEB_SEARCH_CONFIG.provider;
    }
  } else {
    provider = isSupportedProvider(settingProvider)
      ? settingProvider
      : DEFAULT_WEB_SEARCH_CONFIG.provider;
  }

  return {
    enabled: cfg.get<boolean>("enabled", DEFAULT_WEB_SEARCH_CONFIG.enabled),
    provider,
    apiKey,
    maxResults: cfg.get<number>(
      "maxResults",
      DEFAULT_WEB_SEARCH_CONFIG.maxResults,
    ),
    maxUsesPerRequest: cfg.get<number>(
      "maxUsesPerRequest",
      DEFAULT_WEB_SEARCH_CONFIG.maxUsesPerRequest,
    ),
    timeoutMs: cfg.get<number>(
      "timeoutMs",
      DEFAULT_WEB_SEARCH_CONFIG.timeoutMs,
    ),
  };
};

export const isWebSearchActive = (cfg: WebSearchConfig): boolean =>
  cfg.enabled && cfg.apiKey.length > 0;

export const getProvider = (cfg: WebSearchConfig): WebSearchProvider => {
  switch (cfg.provider) {
    case "brave":
      return new BraveSearchProvider(cfg.apiKey, cfg.timeoutMs);
    case "tavily":
    default:
      return new TavilyProvider(cfg.apiKey, cfg.timeoutMs);
  }
};

/**
 * Internal name for the web_search tool when it's exposed to VS Code LM as a
 * regular custom tool. Chosen to be unlikely to collide with any user tool.
 */
export const WEB_SEARCH_TOOL_NAME = "web_search";

export const WEB_SEARCH_TOOL_DESCRIPTION =
  "Search the public web for current information. Use this when you need facts, news, documentation, or anything not in your training data. Returns titles, URLs, and snippets — cite the source URLs in your final answer.";

export const WEB_SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "The search query. Be specific and concise.",
    },
  },
  required: ["query"],
} as const;

export const isWebSearchToolDefinition = (tool: unknown): boolean => {
  const t = tool as { type?: string; name?: string };
  return (
    typeof t.type === "string" &&
    t.type.startsWith("web_search_") &&
    t.name === "web_search"
  );
};

export const buildWebSearchVSCodeTool = (): vscode.LanguageModelChatTool => ({
  name: WEB_SEARCH_TOOL_NAME,
  description: WEB_SEARCH_TOOL_DESCRIPTION,
  inputSchema: WEB_SEARCH_INPUT_SCHEMA,
});

export const logWebSearchActivation = (cfg: WebSearchConfig): void => {
  logger.info(
    `web_search active | provider=${cfg.provider} | maxResults=${cfg.maxResults} | maxUsesPerRequest=${cfg.maxUsesPerRequest}`,
  );
};
