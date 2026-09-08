import { ServerType, serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import * as vscode from "vscode";

import { ExtensionController } from "../core/controller";
import { DEFAULT_CONFIG } from "../utils/config";
import {
  ANOTHER_INSTANCE_RUNNING_MESSAGE,
  EXA_API_KEY_SECRET_KEY,
  PORT_MONITOR_INTERVAL_MS,
} from "../utils/constant";
import { logger } from "../utils/logger";
import { analyzePortUsage } from "../utils/portUtils";
import {
  FileHttpAuthentication,
  HttpAuthentication,
} from "./httpAuthentication";
import { createApiAuthMiddleware } from "./middleware/authMiddleware";
import { registerAnthropicRoutes } from "./routes/anthropicRoutes";
import { registerClineRoutes } from "./routes/clineRoutes";
import { registerFsRoutes } from "./routes/fsRoutes";
import { registerGeminiRoutes } from "./routes/geminiRoutes";
import { registerHealthRoute, registerInfoRoutes } from "./routes/infoRoutes";
import { registerLmRoutes } from "./routes/lmRoutes";
import { registerOpenaiRoutes } from "./routes/openai/openaiRoutes";
import { registerRooRoutes } from "./routes/rooRoutes";
import { registerWorkspaceRoutes } from "./routes/workspaceRoutes";
import { CodexStandaloneWebSearch } from "./webSearch/codexStandaloneWebSearch";
import { EXA_CODEX_TOOLS, ExaMcpClient } from "./webSearch/exaMcpClient";
import { ExaMcpWebSearchProvider } from "./webSearch/exaMcpWebSearchProvider";

export class ProxyServer {
  private app: OpenAPIHono;
  private controller: ExtensionController;
  private context: vscode.ExtensionContext;
  private isRunning = false;
  private port: number;
  private server?: ServerType;
  private portMonitorInterval?: NodeJS.Timeout;
  private readonly codexSearch: CodexStandaloneWebSearch;
  private readonly webSearchProvider: ExaMcpWebSearchProvider;

  constructor(
    controller: ExtensionController,
    port = DEFAULT_CONFIG.proxyServerPort,
    context: vscode.ExtensionContext,
    public readonly authentication: HttpAuthentication = new FileHttpAuthentication(),
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
    this.app.use(cors());
    this.app.use(compress());
    this.app.use("*", async (c, next) => {
      logger.debug(`Incoming request: ${c.req.method} ${c.req.url}`);
      await next();
    });

    // Register authentication before route validators or handlers.
    this.app.use(
      "/api/v1/*",
      createApiAuthMiddleware(this.authentication, "control"),
    );
    this.app.use(
      "/api/anthropic/*",
      createApiAuthMiddleware(this.authentication, "anthropic"),
    );
    this.app.use(
      "/api/openai/*",
      createApiAuthMiddleware(this.authentication, "openai"),
    );
    this.app.use(
      "/api/gemini/*",
      createApiAuthMiddleware(this.authentication, "gemini"),
    );

    registerHealthRoute(this.app);

    // Register routes under the /api/v1 namespace
    this.app.route("/api/v1", this.getApiV1Routes());

    // Anthropic-compatible messages endpoint
    this.app.route("/api/anthropic", this.getApiAnthropicRoutes());

    // OpenAI-compatible messages endpoint
    this.app.route("/api/openai", this.getApiOpenAiRoutes());

    // Gemini-compatible API endpoint
    this.app.route("/api/gemini", this.getApiGeminiRoutes());

    // GET /openapi.json - OpenAPI specification
    for (const [name, header] of [
      ["bearerAuth", undefined],
      ["anthropicAuth", "x-api-key"],
      ["geminiAuth", "x-goog-api-key"],
    ] as const) {
      this.app.openAPIRegistry.registerComponent(
        "securitySchemes",
        name,
        header
          ? { type: "apiKey", in: "header", name: header }
          : { type: "http", scheme: "bearer" },
      );
    }
    this.app.get("/openapi.json", async (c) => {
      const document = this.app.getOpenAPIDocument(this.getOpenApiDocTpl());
      const disabled = (await this.authentication.getStatus()) === "disabled";
      for (const [path, item] of Object.entries(document.paths)) {
        if (!path.startsWith("/api/") || !item) {
          continue;
        }
        const scheme = path.startsWith("/api/anthropic/")
          ? "anthropicAuth"
          : path.startsWith("/api/gemini/")
            ? "geminiAuth"
            : "bearerAuth";
        for (const method of [
          "get",
          "post",
          "put",
          "patch",
          "delete",
          "head",
          "options",
          "trace",
        ] as const) {
          const operation = item[method];
          if (operation) {
            operation.security = disabled ? [] : [{ [scheme]: [] }];
            operation.responses["401"] ??= {
              description: "Missing or invalid API key",
            };
            operation.responses["503"] ??= {
              description:
                "Authentication is unconfigured, unavailable, or busy; retry after configuring or recovering access",
            };
          }
        }
      }
      return c.json(document);
    });
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
        if (analysis.legacy) {
          logger.warn(analysis.message);
          void vscode.window.showWarningMessage(analysis.message);
        }
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
}
