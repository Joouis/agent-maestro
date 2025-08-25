import { ServerType, serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import * as vscode from "vscode";

import { ExtensionController } from "../core/controller";
import { DEFAULT_CONFIG } from "../utils/config";
import { logger } from "../utils/logger";
import { analyzePortUsage } from "../utils/portUtils";
import { registerAnthropicRoutes } from "./routes/anthropicRoutes";
import { registerClineRoutes } from "./routes/clineRoutes";
import { registerFsRoutes } from "./routes/fsRoutes";
import { registerInfoRoutes } from "./routes/infoRoutes";
import { registerLmRoutes } from "./routes/lmRoutes";
import { registerRooRoutes } from "./routes/rooRoutes";
import { registerWorkspaceRoutes } from "./routes/workspaceRoutes";

export class ProxyServer {
  private app: OpenAPIHono;
  private controller: ExtensionController;
  private context: vscode.ExtensionContext;
  private isRunning = false;
  private port: number;
  private server?: ServerType;

  constructor(
    controller: ExtensionController,
    port = DEFAULT_CONFIG.proxyServerPort,
    context: vscode.ExtensionContext,
  ) {
    this.controller = controller;
    this.context = context;
    this.port = port;

    // Initialize OpenAPIHono app with basic middleware
    this.app = new OpenAPIHono();
    this.app.use(cors());
    this.app.use(compress());

    // Register routes under the /api/v1 namespace
    this.app.route("/api/v1", this.getApiV1Routes());

    // Anthropic-compatible messages endpoint
    this.app.route("/api/anthropic", this.getApiAnthropicRoutes());

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
    registerAnthropicRoutes(routes);
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
      logger.warn("Server is already running");
      return { started: false, reason: "Server is already running" };
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
        // Another instance of our server is already running, skip silently
        logger.info(
          `${analysis.message}. API available at http://0.0.0.0:${this.port}/openapi.json`,
        );
        return {
          started: false,
          reason: "Another instance is already running",
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
}
