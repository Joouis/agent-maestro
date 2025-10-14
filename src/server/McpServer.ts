// @ts-expect-error "TS1479: The current file is a CommonJS module"
import { FastMCP } from "fastmcp";
import { z } from "zod";

import { McpTaskManager } from "../core/McpTaskManager";
import { ExtensionController } from "../core/controller";
import { DEFAULT_CONFIG } from "../utils/config";
import {
  ANOTHER_INSTANCE_RUNNING_MESSAGE,
  PORT_MONITOR_INTERVAL_MS,
} from "../utils/constant";
import { logger } from "../utils/logger";
import { analyzePortUsage } from "../utils/portUtils";

// Input schema for the Execute_Roo_Tasks tool
const defaultMaxConcurrency = 5;
const ExecuteRooTasksSchema = z.object({
  tasks: z
    .array(z.string())
    .min(1)
    .describe("Array of task query strings to execute"),
  maxConcurrency: z
    .number()
    .min(1)
    .max(20)
    .default(defaultMaxConcurrency)
    .optional()
    .describe(
      `Maximum number of parallel tasks (1-20, default: ${defaultMaxConcurrency})`,
    ),
});

export interface McpServerConfig {
  port?: number;
  controller: ExtensionController;
}

export class McpServer {
  private taskManager?: McpTaskManager;
  private controller: ExtensionController;
  private port: number;
  private server: FastMCP;
  private isRunning = false;
  private portMonitorInterval?: NodeJS.Timeout;

  constructor(config: McpServerConfig) {
    this.controller = config.controller;
    this.port = config.port || DEFAULT_CONFIG.mcpServerPort;
    this.server = new FastMCP({
      name: "Agent Maestro MCP Server",
      version: "1.0.0",
      health: {
        message: "Agent Maestro MCP Server is running",
      },
    });

    const rooAdapter = this.controller.getRooAdapter();
    if (!rooAdapter) {
      return;
    }
    this.taskManager = new McpTaskManager(rooAdapter);
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<{ started: boolean; reason: string; port?: number }> {
    if (this.isRunning) {
      return { started: false, reason: "MCP Server is already running" };
    }

    if (!this.taskManager) {
      const rooAdapter = this.controller.getRooAdapter();
      if (!rooAdapter) {
        return {
          started: false,
          reason:
            "MCP Server will not start because task manager is not available, this could be no Roo extension is installed nor active.",
        };
      }
      this.taskManager = new McpTaskManager(rooAdapter);
    }

    // Analyze the current port usage
    const analysis = await analyzePortUsage(this.port, "mcp");
    logger.debug(`MCP Port analysis for ${this.port}:`, analysis);

    const actualPort = this.port;

    switch (analysis.action) {
      case "use":
        // Port is available, proceed normally
        break;

      case "skip":
        // Another instance of our server is already running, start monitoring
        logger.info(`MCP Server: ${analysis.message}`);
        this.startPortMonitoring();
        return {
          started: false,
          reason: ANOTHER_INSTANCE_RUNNING_MESSAGE,
          port: this.port,
        };

      case "findAlternative":
        // Port is occupied by another application
        logger.error(
          `MCP Server: Port ${this.port} is in use by another application`,
        );
        throw new Error(
          `MCP Server: Port ${this.port} is already in use by another application. Please configure a different port in settings.`,
        );

      default:
        throw new Error(`Unknown port analysis action: ${analysis.action}`);
    }

    try {
      // Initialize task manager
      await this.taskManager.initialize();

      this.server.addTool({
        name: "Execute Roo Tasks",
        description:
          "Execute multiple RooCode tasks in parallel. Returns real-time progress and results for each task.",
        parameters: ExecuteRooTasksSchema,
        annotations: {
          streamingHint: true, // Enable streaming for real-time updates
          readOnlyHint: true,
        },
        execute: async (args, { streamContent }) => {
          const { tasks, maxConcurrency = defaultMaxConcurrency } = args;
          logger.info(
            `MCP Tool Execute Roo Tasks called with ${tasks.length} tasks, maxConcurrency: ${maxConcurrency}`,
          );

          try {
            // Execute tasks through task manager with streaming
            const taskResults = await this.taskManager!.executeRooTasks(tasks, {
              maxConcurrency,
              streamContent,
            });

            logger.info(`MCP Tool Execute Roo Tasks completed.`);

            return {
              type: "text",
              text: JSON.stringify(taskResults),
            };
          } catch (error) {
            logger.error("Error in Execute Roo Tasks tool:", error);
            throw error;
          }
        },
      });

      // Start the server
      await this.server.start({
        transportType: "httpStream",
        httpStream: {
          port: actualPort,
        },
      });

      this.port = actualPort;
      this.isRunning = true;

      logger.info(`MCP Server started on http://0.0.0.0:${this.port}`);
      logger.info(`MCP Server is ready to accept tool calls`);

      // TODO: Add MCP server info to global state

      return {
        started: true,
        reason: "MCP Server started successfully",
        port: actualPort,
      };
    } catch (error) {
      logger.error("Failed to start MCP server:", error);
      throw error;
    }
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    // Stop port monitoring if active
    this.stopPortMonitoring();

    if (!this.isRunning || !this.taskManager) {
      return;
    }

    try {
      // Stop task manager and cleanup
      await this.taskManager.dispose();
      // Stop MCP server
      await this.server.stop();

      this.isRunning = false;
      logger.info("MCP Server stopped");
    } catch (error) {
      logger.error("Failed to stop MCP server:", error);
      throw error;
    }
  }

  /**
   * Restart the MCP server
   */
  async restart(): Promise<{
    started: boolean;
    reason: string;
    port?: number;
  }> {
    logger.info("Restarting MCP server...");
    await this.stop();
    return await this.start();
  }

  /**
   * Get server status
   */
  getStatus(): { isRunning: boolean; port: number; url: string } {
    return {
      isRunning: this.isRunning,
      port: this.port,
      url: `http://0.0.0.0:${this.port}`,
    };
  }

  /**
   * Start monitoring the port for availability
   */
  private startPortMonitoring(): void {
    if (this.portMonitorInterval) {
      return; // Already monitoring
    }

    logger.info(`Starting MCP server port monitoring for port ${this.port}...`);

    this.portMonitorInterval = setInterval(async () => {
      try {
        const analysis = await analyzePortUsage(this.port, "mcp");
        logger.debug(
          `MCP server port monitoring check for ${this.port}:`,
          analysis,
        );

        if (analysis.action !== "use") {
          return; // Port is still not available
        }

        logger.info(
          `Port ${this.port} is now available, starting MCP server...`,
        );
        this.stopPortMonitoring();

        try {
          await this.start();
        } catch (error) {
          logger.error("Failed to start MCP server after monitoring:", error);
        }
      } catch (error) {
        logger.error("Error during MCP server port monitoring:", error);
      }
    }, PORT_MONITOR_INTERVAL_MS);
  }

  /**
   * Stop monitoring the port
   */
  private stopPortMonitoring(): void {
    if (this.portMonitorInterval) {
      clearInterval(this.portMonitorInterval);
      this.portMonitorInterval = undefined;
      logger.info("MCP Server: Stopped port monitoring");
    }
  }
}
