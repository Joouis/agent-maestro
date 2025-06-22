import { logger } from "../utils/logger";
import { ExtensionController } from "./controller";
import { RooCodeAdapter, TaskEventHandlers } from "./RooCodeAdapter";
import { v4 as uuidv4 } from "uuid";

export interface TaskRun {
  task: string;
  status: "created" | "running" | "completed" | "failed" | "cancelled";
  result: string;
}

export interface StreamContentCallback {
  (content: { type: "text"; text: string }): Promise<void>;
}

export interface ExecuteRooTasksOptions {
  maxConcurrency?: number;
  streamContent?: StreamContentCallback;
  timeout?: number;
}

/**
 * Manages execution of RooCode tasks with real-time streaming
 */
export class McpTaskManager {
  private rooAdapter: RooCodeAdapter;
  private isInitialized = false;

  constructor(controller: ExtensionController) {
    this.rooAdapter = controller.rooCodeAdapter;
  }

  /**
   * Initialize the task manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn("McpTaskManager is already initialized");
      return;
    }

    // Ensure RooCode adapter is ready
    if (!this.rooAdapter.isActive) {
      throw new Error("RooCode adapter is not available");
    }

    this.isInitialized = true;
    logger.info("McpTaskManager initialized successfully");
  }

  /**
   * Execute multiple RooCode tasks with streaming progress updates
   */
  async executeRooTasks(
    taskQueries: string[],
    options: ExecuteRooTasksOptions = {},
  ): Promise<{ [taskId: string]: TaskRun }> {
    if (!this.isInitialized) {
      throw new Error("McpTaskManager is not initialized");
    }

    const {
      maxConcurrency = 3,
      streamContent,
      timeout = 300000, // 5 minutes default timeout
    } = options;

    logger.info(
      `Starting execution of ${taskQueries.length} RooCode tasks with concurrency ${maxConcurrency}`,
    );

    // The run object that tracks all tasks by their RooCode task IDs
    const run: { [taskId: string]: TaskRun } = {};

    // Stream initial content
    if (streamContent) {
      await streamContent({
        type: "text",
        text: this.summarizeRun(run),
      });
    }

    // Process tasks with concurrency control
    const semaphore = new Semaphore(maxConcurrency);
    const taskPromises: Promise<void>[] = [];

    for (const taskQuery of taskQueries) {
      const taskPromise = semaphore.acquire().then(async (release) => {
        try {
          await this.executeTask(taskQuery, run, streamContent, timeout);
        } finally {
          release();
        }
      });

      taskPromises.push(taskPromise);
    }

    // Wait for all tasks to complete
    await Promise.allSettled(taskPromises);

    logger.info(`Completed execution of ${taskQueries.length} RooCode tasks`);
    return run;
  }

  /**
   * Execute a single task and update the run object
   */
  private async executeTask(
    taskQuery: string,
    run: { [taskId: string]: TaskRun },
    streamContent?: StreamContentCallback,
    timeout = 300000,
  ): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
      let taskId = "";

      // Set up timeout
      const timeoutId = setTimeout(() => {
        if (taskId && run[taskId]) {
          run[taskId].status = "failed";
          run[taskId].result = "Task timed out after 5 minutes";

          if (streamContent) {
            streamContent({
              type: "text",
              text: this.summarizeRun(run),
            });
          }
        }
        reject(new Error("Task timeout"));
      }, timeout);

      // Create event handlers for this task
      const eventHandlers: TaskEventHandlers = {
        onTaskCreated: async (id: string) => {
          taskId = id;
          run[taskId] = {
            task: taskQuery,
            status: "created",
            result: "Task created, waiting to start...",
          };

          if (streamContent) {
            await streamContent({
              type: "text",
              text: this.summarizeRun(run),
            });
          }
        },

        onTaskStarted: async (id: string) => {
          if (run[id]) {
            run[id].status = "running";
            run[id].result = "Task started...";

            if (streamContent) {
              await streamContent({
                type: "text",
                text: this.summarizeRun(run),
              });
            }
          }
        },

        onMessage: async (id: string, message: any) => {
          if (run[id]) {
            // FIXME: read the message data structure from ProxyServer and update handler here
            run[id].result = JSON.stringify(message, null, 2);
            if (streamContent) {
              await streamContent({
                type: "text",
                text: this.summarizeRun(run),
              });
            }
          }
        },

        onTaskCompleted: async (
          id: string,
          tokenUsage: any,
          toolUsage: any,
        ) => {
          clearTimeout(timeoutId);
          if (run[id]) {
            run[id].status = "completed";
            // Keep the last message content as the final result
            if (!run[id].result || run[id].result === "Task started...") {
              run[id].result = "Task completed successfully";
            }

            if (streamContent) {
              await streamContent({
                type: "text",
                text: this.summarizeRun(run),
              });
            }
          }
          resolve();
        },

        onTaskAborted: async (id: string) => {
          clearTimeout(timeoutId);
          if (run[id]) {
            run[id].status = "cancelled";
            run[id].result = "Task was cancelled";

            if (streamContent) {
              await streamContent({
                type: "text",
                text: this.summarizeRun(run),
              });
            }
          }
          resolve();
        },

        onTaskToolFailed: async (id: string, tool: string, error: string) => {
          clearTimeout(timeoutId);
          if (run[id]) {
            run[id].status = "failed";
            run[id].result = `Tool ${tool} failed: ${error}`;

            if (streamContent) {
              await streamContent({
                type: "text",
                text: this.summarizeRun(run),
              });
            }
          }
          resolve();
        },
      };

      try {
        const taskId = await this.rooAdapter.startNewTask({
          text: taskQuery,
          newTab: true,
          eventHandlers,
        });
        run[taskId] = {
          task: taskQuery,
          status: "created",
          result: "Task created, waiting to start...",
        };
      } catch (error: any) {
        clearTimeout(timeoutId);
        logger.error(`Failed to start RooCode task: ${taskQuery}`, error);

        run[uuidv4()] = {
          task: taskQuery,
          status: "failed",
          result: `Failed to start task: ${error.message}`,
        };

        if (streamContent) {
          await streamContent({
            type: "text",
            text: this.summarizeRun(run),
          });
        }
        reject(error);
      }
    });
  }

  /**
   * Convert the run object to markdown format
   */
  private summarizeRun(run: { [taskId: string]: TaskRun }): string {
    if (Object.keys(run).length === 0) {
      return "# RooCode Tasks\n\n*No tasks started yet...*\n\n";
    }

    let markdown = "# RooCode Tasks\n\n";

    for (const [taskId, taskRun] of Object.entries(run)) {
      let statusText = "";

      switch (taskRun.status) {
        case "created":
          statusText = "(Created)";
          break;
        case "running":
          statusText = "(Ongoing)";
          break;
        case "completed":
          statusText = "";
          break;
        case "failed":
          statusText = "(Failed)";
          break;
        case "cancelled":
          statusText = "(Cancelled)";
          break;
      }

      markdown += `## ${taskRun.task} ${statusText}\n\n`;
      markdown += `${taskRun.result}\n\n`;

      // Add task ID for reference in completed/failed cases
      if (taskRun.status === "completed" || taskRun.status === "failed") {
        markdown += `*Task ID: ${taskId}*\n\n`;
      }

      markdown += "---\n\n";
    }

    return markdown;
  }

  /**
   * Cleanup and dispose resources
   */
  async dispose(): Promise<void> {
    logger.info("Disposing McpTaskManager");
    this.isInitialized = false;
    logger.info("McpTaskManager disposed");
  }
}

/**
 * Simple semaphore for concurrency control
 */
class Semaphore {
  private permits: number;
  private waitQueue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.permits > 0) {
        this.permits--;
        resolve(() => this.release());
      } else {
        this.waitQueue.push(() => {
          this.permits--;
          resolve(() => this.release());
        });
      }
    });
  }

  private release(): void {
    this.permits++;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    }
  }
}
