import { ServerType, serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { compress } from "hono/compress";
import * as vscode from "vscode";

import { ExtensionController } from "../core/controller";
import { DEFAULT_CONFIG, readConfiguration } from "../utils/config";
import {
  ADMIN_API_KEY_SECRET_KEY,
  ANOTHER_INSTANCE_RUNNING_MESSAGE,
  EXA_API_KEY_SECRET_KEY,
  LLM_API_KEY_SECRET_KEY,
  PORT_MONITOR_INTERVAL_MS,
} from "../utils/constant";
import { logger } from "../utils/logger";
import { analyzePortUsage } from "../utils/portUtils";
import {
  type ApiKeyState,
  type ApiKeys,
  createAdminAuthMiddleware,
  createAnthropicAuthMiddleware,
  createGeminiAuthMiddleware,
  createOpenAIAuthMiddleware,
} from "./middleware/authMiddleware";
import {
  createCorsMiddleware,
  createOriginGuardMiddleware,
} from "./middleware/originMiddleware";
import { registerAnthropicRoutes } from "./routes/anthropicRoutes";
import { registerClineRoutes } from "./routes/clineRoutes";
import { registerFsRoutes } from "./routes/fsRoutes";
import { registerGeminiRoutes } from "./routes/geminiRoutes";
import { registerInfoRoutes } from "./routes/infoRoutes";
import { registerLmRoutes } from "./routes/lmRoutes";
import { registerOpenaiRoutes } from "./routes/openai/openaiRoutes";
import { registerRooRoutes } from "./routes/rooRoutes";
import { registerWorkspaceRoutes } from "./routes/workspaceRoutes";
import { CodexStandaloneWebSearch } from "./webSearch/codexStandaloneWebSearch";
import { EXA_CODEX_TOOLS, ExaMcpClient } from "./webSearch/exaMcpClient";
import { ExaMcpWebSearchProvider } from "./webSearch/exaMcpWebSearchProvider";

export const HEALTH_PATH = "/health";

const SECRET_KEYS: Record<keyof ApiKeys, string> = {
  llm: LLM_API_KEY_SECRET_KEY,
  admin: ADMIN_API_KEY_SECRET_KEY,
};

const KEY_LABELS: Record<keyof ApiKeys, string> = {
  llm: "LLM",
  admin: "Admin",
};

function sameKeyState(a: ApiKeyState, b: ApiKeyState): boolean {
  if (a.status === "set" && b.status === "set") {
    return a.value === b.value;
  }
  return a.status === b.status;
}

export class ProxyServer {
  private app: OpenAPIHono;
  private controller: ExtensionController;
  private context: vscode.ExtensionContext;
  private isRunning = false;
  private port: number;
  private server?: ServerType;
  private portMonitorInterval?: NodeJS.Timeout;
  private apiKeys: ApiKeys = {
    llm: { status: "unset" },
    admin: { status: "unset" },
  };
  private apiKeysChangeListeners: (() => void)[] = [];
  // Bumped per key by every refresh and local set of that key. A refresh
  // publishes only if nothing newer touched the same key while it was
  // reading; the other key is never affected.
  private keyGeneration: Record<keyof ApiKeys, number> = { llm: 0, admin: 0 };
  private pendingRefreshes: Promise<void> = Promise.resolve();
  private readonly codexSearch: CodexStandaloneWebSearch;
  private readonly webSearchProvider: ExaMcpWebSearchProvider;

  constructor(
    controller: ExtensionController,
    port = DEFAULT_CONFIG.proxyServerPort,
    context: vscode.ExtensionContext,
  ) {
    this.controller = controller;
    this.context = context;
    this.port = port;
    const exaMcpClient = new ExaMcpClient({
      getApiKey: () =>
        Promise.resolve(this.context.secrets.get(EXA_API_KEY_SECRET_KEY)),
      tools: EXA_CODEX_TOOLS,
    });
    this.webSearchProvider = new ExaMcpWebSearchProvider({
      client: exaMcpClient,
    });
    this.codexSearch = new CodexStandaloneWebSearch({
      client: exaMcpClient,
    });

    // Initialize OpenAPIHono app with basic middleware
    this.app = new OpenAPIHono();
    this.app.use("*", async (c, next) => {
      logger.debug(`Incoming request: ${c.req.method} ${c.req.url}`);
      await next();
    });

    // Origin checks run before compression, auth, and handlers so a rejected
    // browser request never reaches route code.
    const getCorsOrigins = () => readConfiguration().proxyServerCorsOrigins;
    this.app.use(createOriginGuardMiddleware(getCorsOrigins, [HEALTH_PATH]));
    this.app.use(createCorsMiddleware(getCorsOrigins));
    this.app.use(compress());

    // Port-conflict detection probes this route, so it needs no key.
    this.app.get(HEALTH_PATH, (c) => c.json({ name: "Agent Maestro" }));

    const getApiKeys = () => this.apiKeys;
    this.app.use("/api/anthropic/*", createAnthropicAuthMiddleware(getApiKeys));
    this.app.use("/api/openai/*", createOpenAIAuthMiddleware(getApiKeys));
    this.app.use("/api/gemini/*", createGeminiAuthMiddleware(getApiKeys));
    this.app.use("/api/v1/*", createAdminAuthMiddleware(getApiKeys));
    this.app.use("/openapi.json", createAdminAuthMiddleware(getApiKeys));

    // Register routes under the /api/v1 namespace
    this.app.route("/api/v1", this.getApiV1Routes());

    // Anthropic-compatible messages endpoint
    this.app.route("/api/anthropic", this.getApiAnthropicRoutes());

    // OpenAI-compatible messages endpoint
    this.app.route("/api/openai", this.getApiOpenAiRoutes());

    // Gemini-compatible API endpoint
    this.app.route("/api/gemini", this.getApiGeminiRoutes());

    // GET /openapi.json - OpenAPI specification
    this.app.doc("/openapi.json", this.getOpenApiDocTpl());
  }

  private getApiV1Routes(): OpenAPIHono {
    const routes = new OpenAPIHono();

    registerInfoRoutes(routes, this.controller);
    registerLmRoutes(routes);
    registerClineRoutes(routes, this.controller);
    registerWorkspaceRoutes(routes);
    registerFsRoutes(routes);
    registerRooRoutes(routes, this.controller, this.context);

    return routes;
  }

  private getApiAnthropicRoutes(): OpenAPIHono {
    const routes = new OpenAPIHono();
    registerAnthropicRoutes(routes, {
      webSearchProvider: this.webSearchProvider,
    });
    return routes;
  }

  private getApiOpenAiRoutes(): OpenAPIHono {
    const routes = new OpenAPIHono();
    registerOpenaiRoutes(routes, {
      codexSearch: this.codexSearch,
      webSearchProvider: this.webSearchProvider,
    });
    return routes;
  }

  private getApiGeminiRoutes(): OpenAPIHono {
    const routes = new OpenAPIHono();
    registerGeminiRoutes(routes);
    return routes;
  }

  private getOpenApiDocTpl() {
    return {
      openapi: "3.0.0",
      info: {
        title: "Agent Maestro API",
        description: "API for managing extension tasks",
        version: "1.0.0",
      },
      servers: [
        {
          url: `http://0.0.0.0:${this.port}`,
          description: "Development server",
        },
      ],
      tags: [
        {
          name: "Tasks",
          description: "Task management operations",
        },
        {
          name: "FileSystem",
          description: "File system operations",
        },
        {
          name: "System",
          description: "System information and status",
        },
        {
          name: "Workspace",
          description: "Workspace management and editor operations",
        },
        {
          name: "Language Models",
          description: "VSCode language model operations",
        },
        {
          name: "Anthropic API",
          description:
            "Anthropic-compatible API endpoints using VSCode Language Models",
        },
        {
          name: "OpenAI API",
          description:
            "OpenAI-compatible API endpoints using VSCode Language Models",
        },
        {
          name: "Codex Compatibility",
          description:
            "Experimental, versioned compatibility endpoints for Codex clients",
        },
        {
          name: "Google Gemini API",
          description:
            "Gemini-compatible API endpoints using VSCode Language Models",
        },
        {
          name: "MCP Configuration",
          description: "MCP server configuration operations",
        },
        {
          name: "Configuration",
          description: "Profile and configuration management",
        },
        {
          name: "Documentation",
          description: "API documentation",
        },
      ],
    };
  }

  async start(): Promise<{ started: boolean; reason: string; port?: number }> {
    if (this.isRunning) {
      return { started: false, reason: "Proxy server is already running" };
    }

    // Analyze the current port usage
    const analysis = await analyzePortUsage(this.port, "proxy");
    logger.debug(`Port analysis for ${this.port}:`, analysis);

    switch (analysis.action) {
      case "use":
        // Port is available, proceed normally
        try {
          this.server = serve({
            fetch: this.app.fetch,
            port: this.port,
          });
          this.isRunning = true;
          logger.info(`Server started on http://0.0.0.0:${this.port}`);
          logger.info(
            `API documentation: http://0.0.0.0:${this.port}/openapi.json`,
          );
          return {
            started: true,
            reason: "Server started successfully",
            port: this.port,
          };
        } catch (error) {
          logger.error("Failed to start server:", error);
          throw error;
        }

      case "skip":
        // Another instance of our server is already running, start monitoring
        logger.info(
          `${analysis.message}. API available at http://0.0.0.0:${this.port}/openapi.json`,
        );
        // Start monitoring for when the port becomes available
        this.startPortMonitoring();
        return {
          started: false,
          reason: ANOTHER_INSTANCE_RUNNING_MESSAGE,
          port: this.port,
        };

      case "findAlternative":
        // Port is occupied by another application
        logger.error(`Port ${this.port} is in use by another application`);
        throw new Error(
          `Port ${this.port} is already in use by another application. Please configure a different port in settings.`,
        );

      default:
        throw new Error(`Unknown port analysis action: ${analysis.action}`);
    }
  }

  async stop(): Promise<void> {
    // Stop port monitoring if active
    this.stopPortMonitoring();

    if (!this.isRunning) {
      logger.warn("Server is not running");
      return;
    }

    try {
      if (this.server) {
        this.server.close();
        this.server = undefined;
      }
      this.isRunning = false;
      logger.info("Server stopped");
    } catch (error) {
      logger.error("Failed to stop server:", error);
      throw error;
    }
  }

  async restart(): Promise<{
    started: boolean;
    reason: string;
    port?: number;
  }> {
    logger.info("Restarting server...");
    await this.stop();
    return await this.start();
  }

  getStatus(): { isRunning: boolean; port: number; url: string } {
    return {
      isRunning: this.isRunning,
      port: this.port,
      url: `http://0.0.0.0:${this.port}`,
    };
  }

  getOpenApiUrl(): string {
    return `http://0.0.0.0:${this.port}/openapi.json`;
  }

  private startPortMonitoring() {
    if (this.portMonitorInterval) {
      return; // Monitoring is already active
    }

    logger.info(
      `Starting proxy server port monitoring for port ${this.port}...`,
    );

    this.portMonitorInterval = setInterval(async () => {
      try {
        const analysis = await analyzePortUsage(this.port, "proxy");
        logger.debug(
          `Proxy server port monitoring check for ${this.port}:`,
          analysis,
        );

        if (analysis.action !== "use") {
          return; // Port is still not available
        }

        logger.info(
          `Port ${this.port} is now available, starting proxy server...`,
        );
        this.stopPortMonitoring();

        try {
          await this.start();
        } catch (error) {
          logger.error("Failed to start proxy server after monitoring:", error);
        }
      } catch (error) {
        logger.error("Error during proxy server port monitoring:", error);
      }
    }, PORT_MONITOR_INTERVAL_MS);
  }

  private stopPortMonitoring() {
    if (this.portMonitorInterval) {
      clearInterval(this.portMonitorInterval);
      this.portMonitorInterval = undefined;
    }
  }

  setLlmApiKey(key: string | null): void {
    this.setApiKey("llm", key);
  }

  setAdminApiKey(key: string | null): void {
    this.setApiKey("admin", key);
  }

  getApiKeys(): ApiKeys {
    return this.apiKeys;
  }

  getLlmApiKey(): string | null {
    return this.apiKeys.llm.status === "set" ? this.apiKeys.llm.value : null;
  }

  /** Listeners run after any key change, including a restore. */
  onApiKeysChanged(listener: () => void): void {
    this.apiKeysChangeListeners.push(listener);
  }

  private setApiKey(kind: keyof ApiKeys, key: string | null): void {
    const trimmed = key?.trim();
    const state: ApiKeyState = trimmed
      ? { status: "set", value: trimmed }
      : { status: "unset" };
    this.keyGeneration[kind]++;
    this.updateApiKeys({ ...this.apiKeys, [kind]: state });
  }

  private updateApiKeys(next: ApiKeys): void {
    const changed = (Object.keys(next) as (keyof ApiKeys)[]).filter(
      (kind) => !sameKeyState(this.apiKeys[kind], next[kind]),
    );
    this.apiKeys = next;
    if (changed.length === 0) {
      return;
    }
    for (const kind of changed) {
      logger.info(`${KEY_LABELS[kind]} API key is now ${next[kind].status}`);
    }
    this.warnIfWildcardWithoutKeys();
    for (const listener of this.apiKeysChangeListeners) {
      listener();
    }
  }

  /**
   * Restores both keys from secret storage. Must run before either server
   * starts. A failed read locks the key so its routes fail closed instead of
   * silently opening.
   */
  restoreApiKeys(): Promise<void> {
    void this.refreshApiKey("llm");
    return this.refreshApiKey("admin");
  }

  /**
   * Re-reads one key from secret storage, replacing its in-memory value.
   *
   * Refreshes are per key, so a change to one secret never reloads the other.
   * That keeps a key that is set only in memory (its save failed) from being
   * replaced by an unrelated secret event. Overlapping refreshes of the same
   * key publish only the latest, so a slow read cannot re-enable a revoked
   * key, and a local set during the read wins. The returned promise settles
   * once no refresh is in flight, so activation never starts on superseded
   * state.
   */
  refreshApiKey(kind: keyof ApiKeys): Promise<void> {
    const generation = ++this.keyGeneration[kind];
    const run = this.readStoredApiKey(kind).then((state) => {
      if (generation === this.keyGeneration[kind]) {
        this.updateApiKeys({ ...this.apiKeys, [kind]: state });
      }
    });
    this.pendingRefreshes = Promise.all([this.pendingRefreshes, run]).then(
      () => undefined,
    );
    return this.waitForPendingRefreshes();
  }

  private async waitForPendingRefreshes(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.pendingRefreshes;
      await current;
    } while (current !== this.pendingRefreshes);
  }

  private async readStoredApiKey(kind: keyof ApiKeys): Promise<ApiKeyState> {
    try {
      const stored = (
        await this.context.secrets.get(SECRET_KEYS[kind])
      )?.trim();
      return stored ? { status: "set", value: stored } : { status: "unset" };
    } catch (error) {
      logger.error(
        `Failed to restore ${KEY_LABELS[kind]} API key from secret storage. Routes it protects will return 503 until the key is set again:`,
        error,
      );
      return { status: "locked" };
    }
  }

  /** Keeps in-memory keys in sync with key changes made in other windows. */
  watchApiKeySecrets(): vscode.Disposable {
    return this.context.secrets.onDidChange((event) => {
      for (const kind of Object.keys(SECRET_KEYS) as (keyof ApiKeys)[]) {
        if (SECRET_KEYS[kind] === event.key) {
          void this.refreshApiKey(kind);
        }
      }
    });
  }

  warnIfWildcardWithoutKeys(): void {
    const { llm, admin } = this.apiKeys;
    if (llm.status !== "unset" || admin.status !== "unset") {
      return;
    }
    const config = readConfiguration();
    for (const [name, origins] of [
      ["proxyServerCorsOrigins", config.proxyServerCorsOrigins],
      ["mcpServerCorsOrigins", config.mcpServerCorsOrigins],
    ] as const) {
      if (origins.includes("*")) {
        logger.warn(
          `agent-maestro.${name} allows any origin ("*") but no API key is set: any web page can call this server. Set an Admin API Key or list specific origins.`,
        );
      }
    }
  }
}
