import * as os from "os";
import * as path from "path";

export const GROK_BUILD_MODEL_KEY = "agent-maestro";
export const GROK_BUILD_MODEL_NAME = "Agent Maestro";
export const GROK_BUILD_PLACEHOLDER_API_KEY = "Powered by Agent Maestro";

const GROK_BUILD_API_BACKENDS = {
  chat_completions: "/api/openai/v1",
  responses: "/api/openai/v1",
  messages: "/api/anthropic/v1",
} as const;

export type GrokBuildApiBackend = keyof typeof GROK_BUILD_API_BACKENDS;

export function isGrokBuildApiBackend(
  apiBackend: unknown,
): apiBackend is GrokBuildApiBackend {
  return (
    typeof apiBackend === "string" &&
    Object.hasOwn(GROK_BUILD_API_BACKENDS, apiBackend)
  );
}

export function resolveGrokBuildBaseUrl(
  proxyBaseUrl: string,
  apiBackend: unknown,
): string {
  const origin = new URL(proxyBaseUrl).origin;
  const backendPath = isGrokBuildApiBackend(apiBackend)
    ? GROK_BUILD_API_BACKENDS[apiBackend]
    : GROK_BUILD_API_BACKENDS.chat_completions;
  return `${origin}${backendPath}`;
}

export interface GrokBuildModelEntry {
  model: string;
  base_url: string;
  name: string;
  api_key: string;
  context_window?: number;
  [key: string]: unknown;
}

export interface GrokBuildConfig {
  models?: Record<string, unknown>;
  model?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function getGrokBuildConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const grokHome = env.GROK_HOME?.trim();
  const configDir = grokHome ? grokHome : path.join(homeDir, ".grok");
  return path.join(configDir, "config.toml");
}

export function buildGrokBuildConfig(options: {
  existingConfig: GrokBuildConfig;
  modelId: string;
  baseUrl: string;
  contextWindow?: number;
  configuredApiKey?: string | null;
}): GrokBuildConfig {
  const { existingConfig, modelId, baseUrl, contextWindow, configuredApiKey } =
    options;
  const existingModel = existingConfig.model?.[GROK_BUILD_MODEL_KEY] ?? {};
  const existingApiKey =
    typeof existingModel.api_key === "string"
      ? existingModel.api_key
      : undefined;
  const apiKey =
    configuredApiKey?.trim() ||
    existingApiKey ||
    GROK_BUILD_PLACEHOLDER_API_KEY;

  const modelEntry: GrokBuildModelEntry = {
    ...existingModel,
    model: modelId,
    base_url: resolveGrokBuildBaseUrl(baseUrl, existingModel.api_backend),
    name: GROK_BUILD_MODEL_NAME,
    api_key: apiKey,
  };

  // The flag describes the previous endpoint. The proxy does not serve it.
  delete modelEntry.supports_backend_search;
  if (!isGrokBuildApiBackend(modelEntry.api_backend)) {
    delete modelEntry.api_backend;
  } else if (modelEntry.api_backend === "messages") {
    // The Anthropic route accepts x-api-key, not the bearer token from api_key.
    const existingHeaders =
      modelEntry.extra_headers &&
      typeof modelEntry.extra_headers === "object" &&
      !Array.isArray(modelEntry.extra_headers)
        ? modelEntry.extra_headers
        : {};
    const extraHeaders = Object.fromEntries(
      Object.entries(existingHeaders).filter(
        ([name]) => name.toLowerCase() !== "x-api-key",
      ),
    );
    extraHeaders["x-api-key"] = apiKey;
    modelEntry.extra_headers = extraHeaders;
  }

  if (contextWindow !== undefined && contextWindow > 0) {
    modelEntry.context_window = contextWindow;
  } else {
    delete modelEntry.context_window;
  }

  return {
    ...existingConfig,
    models: {
      ...existingConfig.models,
      default: GROK_BUILD_MODEL_KEY,
    },
    model: {
      ...existingConfig.model,
      [GROK_BUILD_MODEL_KEY]: modelEntry,
    },
  };
}
