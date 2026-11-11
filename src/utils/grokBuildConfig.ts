import * as os from "os";
import * as path from "path";

export const GROK_BUILD_MODEL_KEY = "agent-maestro";
export const GROK_BUILD_MODEL_NAME = "Agent Maestro";
export const GROK_BUILD_PLACEHOLDER_API_KEY = "Powered by Agent Maestro";

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
    base_url: baseUrl,
    name: GROK_BUILD_MODEL_NAME,
    api_key: apiKey,
  };

  // The flag describes the endpoint. The proxy does not serve Grok's backend search.
  delete modelEntry.supports_backend_search;

  if (contextWindow !== undefined) {
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
