import Fastify, { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import cors from "@fastify/cors";
import * as vscode from "vscode";
import { logger } from "../utils/logger";
import { analyzePortUsage } from "../utils/portUtils";
import { ExtensionController } from "../core/controller";
import { registerRooRoutes } from "./routes/rooRoutes";
import { registerClineRoutes } from "./routes/clineRoutes";
import { registerFsRoutes } from "./routes/fsRoutes";
import { registerInfoRoutes } from "./routes/infoRoutes";
import { DEFAULT_CONFIG } from "../utils/config";

export class ProxyServer {
  private fastify: FastifyInstance;
  private controller: ExtensionController;
  private context?: vscode.ExtensionContext;
  private isRunning = false;
  private port: number;

  constructor(
    controller: ExtensionController,
    port = DEFAULT_CONFIG.proxyServerPort,
    context?: vscode.ExtensionContext,
  ) {
    this.controller = controller;
    this.context = context;
    this.port = port;
    this.fastify = Fastify({
      logger: false, // Use our custom logger instead
    });
  }

  /**
   * Initializes the server by setting up CORS, Swagger, and routes.
   */
  private async initialize(): Promise<void> {
    await this.setupCors();
    await this.setupSwagger();
    await this.setupRoutes();
  }

  private async setupCors(): Promise<void> {
    await this.fastify.register(cors, {
      origin: true, // Allow all origins, you can restrict this to specific domains if needed
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Accept"],
      credentials: true,
    });
  }

  private async setupSwagger(): Promise<void> {
    await this.fastify.register(swagger, {
      openapi: {
        openapi: "3.0.0",
        info: {
          title: "Cline Maestro API",
          description: "API for managing extension tasks",
          version: "0.0.1",
        },
        servers: [
          {
            url: `http://127.0.0.1:${this.port}/api/v1`,
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
            name: "MCP Configuration",
            description: "MCP server configuration operations",
          },
          {
            name: "Documentation",
            description: "API documentation",
          },
        ],
        components: {},
      },
      refResolver: {
        buildLocalReference: (json, _baseUri, _fragment, i) =>
          String(json.$id) || `id-${i}`,
      },
      prefix: "/api/v1",
    });
    this.fastify.addSchema({
      $id: "MessageRequest",
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          description: "The task query to execute",
        },
        images: {
          type: "array",
          items: { type: "string" },
          description: "Optional array of base64-encoded images",
        },
        extensionId: {
          type: "string",
          description:
            "Optional, assign task to a specific Roo variant extension like Kilo Code, by default is RooCode extension",
        },
      },
    });
    this.fastify.addSchema({
      $id: "TaskResponse",
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique task identifier",
        },
        status: {
          type: "string",
          enum: ["created", "running", "completed", "failed"],
          description: "Current task status",
        },
        message: {
          type: "string",
          description: "Status message",
        },
      },
    });
    this.fastify.addSchema({
      $id: "ErrorResponse",
      type: "object",
      properties: {
        message: { type: "string" },
      },
    });
    this.fastify.addSchema({
      $id: "FileReadRequest",
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "File path relative to VS Code workspace root",
        },
      },
    });
    this.fastify.addSchema({
      $id: "FileReadResponse",
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The file path that was read",
        },
        content: {
          type: "string",
          description:
            "File content (UTF-8 for text files, base64 for binary files)",
        },
        encoding: {
          type: "string",
          description:
            "Content encoding (utf8 for text files, base64 for binary files)",
        },
        size: {
          type: "number",
          description: "File size in bytes",
        },
        mimeType: {
          type: "string",
          description: "Detected MIME type",
        },
      },
    });
  }

  private async setupRoutes(): Promise<void> {
    // Register API routes with prefix
    await this.fastify.register(
      async (fastify) => {
        await registerClineRoutes(fastify, this.controller);
        await registerRooRoutes(fastify, this.controller, this.context);
        await registerFsRoutes(fastify);
        await registerInfoRoutes(fastify, this.controller);

        // GET /api/v1/openapi.json - OpenAPI specification
        fastify.get(
          "/openapi.json",
          {
            schema: {
              tags: ["Documentation"],
              summary: "Get OpenAPI specification",
              description:
                "Returns the complete OpenAPI v3 specification for this API",
              response: {
                200: {
                  description: "OpenAPI specification",
                  type: "object",
                },
              },
            },
          },
          async (_request, reply) => {
            const swaggerDoc = fastify.swagger();
            return reply
              .header("Content-Type", "application/json")
              .send(JSON.stringify(swaggerDoc, null, 2));
          },
        );
      },
      { prefix: "/api/v1" },
    );
  }

  async start(): Promise<{ started: boolean; reason: string; port?: number }> {
    if (this.isRunning) {
      logger.warn("Server is already running");
      return { started: false, reason: "Server is already running" };
    }

    // Perform initialization first
    try {
      await this.initialize();
    } catch (error) {
      logger.error("Failed to initialize server:", error);
      throw new Error(
        `Server initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Analyze the current port usage
    const analysis = await analyzePortUsage(this.port);
    logger.debug(`Port analysis for ${this.port}:`, analysis);

    switch (analysis.action) {
      case "use":
        // Port is available, proceed normally
        try {
          await this.fastify.listen({
            port: this.port,
            host: "127.0.0.1",
          });
          this.isRunning = true;
          logger.info(`Server started on http://127.0.0.1:${this.port}`);
          logger.info(
            `API documentation: http://127.0.0.1:${this.port}/api/v1/openapi.json`,
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
          `${analysis.message}. API available at http://127.0.0.1:${this.port}/api/v1/openapi.json`,
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
      await this.fastify.close();
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
      url: `http://localhost:${this.port}`,
    };
  }

  getOpenAPIUrl(): string {
    return `http://localhost:${this.port}/api/v1/openapi.json`;
  }
}
