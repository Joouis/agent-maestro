import * as fs from "fs";
import * as path from "path";

type JsonObject = Record<string, unknown>;

export interface CodexModelSelection {
  modelId: string;
  maxInputTokens: number;
}

export interface CodexConfigurationUpdate {
  config: JsonObject;
  catalog?: JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contextWindow(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Codex context windows must be positive safe integers.");
  }
  return value;
}

function setContextWindow(model: JsonObject, value: unknown): void {
  const window = contextWindow(value);
  model.context_window = window;
  if ("max_context_window" in model) {
    model.max_context_window = Math.max(
      contextWindow(model.max_context_window),
      window,
    );
  }
}

export function resolveCodexCatalogPath(
  configPath: string,
  catalogPath: unknown,
): string {
  if (typeof catalogPath !== "string" || !catalogPath.trim()) {
    throw new Error("model_catalog_json must name a local JSON catalog.");
  }
  if (catalogPath.startsWith("~") || /^[a-z]+:\/\//i.test(catalogPath)) {
    throw new Error(
      "Use a filesystem path for model_catalog_json, not ~ or a URL.",
    );
  }
  const resolved = path.resolve(path.dirname(configPath), catalogPath);
  const normalize = (file: string) =>
    process.platform === "win32" ? file.toLowerCase() : file;
  const sameFile =
    fs.existsSync(resolved) && fs.existsSync(configPath)
      ? (() => {
          const catalogStat = fs.statSync(resolved);
          const configStat = fs.statSync(configPath);
          return (
            catalogStat.dev === configStat.dev &&
            catalogStat.ino === configStat.ino
          );
        })()
      : false;
  if (normalize(resolved) === normalize(path.resolve(configPath)) || sameFile) {
    throw new Error(
      "The Codex catalog and configuration must be different files.",
    );
  }
  return resolved;
}

export function createCodexConfiguration(
  existing: JsonObject,
  selected: CodexModelSelection,
  proxyPort: number,
  catalog?: unknown,
): CodexConfigurationUpdate {
  const providers = isObject(existing.model_providers)
    ? existing.model_providers
    : {};
  const provider = isObject(providers["agent-maestro"])
    ? providers["agent-maestro"]
    : {};
  const config: JsonObject = {
    ...existing,
    model: selected.modelId,
    model_provider: "agent-maestro",
    web_search: existing.web_search === "disabled" ? "disabled" : "live",
    features: {
      ...(isObject(existing.features) ? existing.features : {}),
      standalone_web_search: true,
    },
    model_providers: {
      ...providers,
      "agent-maestro": {
        ...provider,
        name: "Agent Maestro",
        base_url: `http://127.0.0.1:${proxyPort}/api/openai/v1`,
        wire_api: "responses",
        supports_standalone_web_search: true,
      },
    },
  };

  if (existing.model_catalog_json === undefined) {
    config.model_context_window = contextWindow(selected.maxInputTokens);
    return { config };
  }

  if (!isObject(catalog) || !Array.isArray(catalog.models)) {
    throw new Error("The Codex catalog must contain a models array.");
  }
  const models: JsonObject[] = [];
  const byId = new Map<string, JsonObject>();
  for (const entry of catalog.models) {
    if (
      !isObject(entry) ||
      typeof entry.slug !== "string" ||
      !entry.slug.trim()
    ) {
      throw new Error("Every Codex catalog entry must have a nonempty slug.");
    }
    if (byId.has(entry.slug)) {
      throw new Error(`Duplicate Codex catalog model: ${entry.slug}`);
    }
    const model = { ...entry };
    models.push(model);
    byId.set(entry.slug, model);
  }
  const selectedEntry = byId.get(selected.modelId);
  if (!selectedEntry) {
    throw new Error(
      `Add '${selected.modelId}' to model_catalog_json before configuring Codex. Its client capabilities cannot be inferred from its name.`,
    );
  }

  if (
    existing.model_context_window !== undefined ||
    existing.model_reasoning_effort !== undefined
  ) {
    const previous =
      typeof existing.model === "string" ? byId.get(existing.model) : undefined;
    if (!previous) {
      throw new Error(
        "Cannot move global Codex overrides: the previous default model is missing from the catalog.",
      );
    }
    if (existing.model_context_window !== undefined) {
      setContextWindow(previous, existing.model_context_window);
    }
    if (existing.model_reasoning_effort !== undefined) {
      const effort = existing.model_reasoning_effort;
      if (
        typeof effort !== "string" ||
        !Array.isArray(previous.supported_reasoning_levels) ||
        !previous.supported_reasoning_levels.some(
          (option) => isObject(option) && option.effort === effort,
        )
      ) {
        throw new Error(
          "Cannot move the global reasoning effort: it is not declared by the previous default model's catalog entry.",
        );
      }
      previous.default_reasoning_level = effort;
    }
  }
  setContextWindow(selectedEntry, selected.maxInputTokens);
  delete config.model_context_window;
  delete config.model_reasoning_effort;
  return { config, catalog: { ...catalog, models } };
}

export function writeCodexConfiguration(
  configPath: string,
  configContent: string,
  catalog?: { path: string; content: string },
): void {
  const files = [
    ...(catalog ? [{ path: catalog.path, content: catalog.content }] : []),
    { path: configPath, content: configContent },
  ].map((file) => ({
    ...file,
    original: fs.existsSync(file.path) ? fs.readFileSync(file.path) : undefined,
    mode: fs.existsSync(file.path)
      ? fs.statSync(file.path).mode & 0o777
      : undefined,
  }));
  // Both backups must succeed before either live file changes.
  const suffix = `.agent-maestro-${Date.now()}.bak`;
  for (const file of files) {
    if (file.original) {
      fs.writeFileSync(file.path + suffix, file.original, {
        flag: "wx",
        mode: file.mode,
      });
    }
  }
  const written: typeof files = [];
  try {
    for (const file of files) {
      written.push(file);
      fs.writeFileSync(file.path, file.content);
    }
  } catch (error) {
    const restoreErrors: string[] = [];
    for (const file of written.reverse()) {
      try {
        if (file.original) {
          fs.writeFileSync(file.path, file.original);
        } else if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      } catch {
        restoreErrors.push(file.path);
      }
    }
    if (restoreErrors.length > 0) {
      throw new Error(
        `Codex configuration write failed; restore these files from their '${suffix}' backups: ${restoreErrors.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
}
