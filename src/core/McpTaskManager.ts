import { ClineMessage } from "@roo-code/types";
import { Semaphore } from "es-toolkit";
import { logger } from "../utils/logger";
import { RooCodeAdapter, TaskEventHandlers } from "./RooCodeAdapter";
import { v4 as uuidv4 } from "uuid";
import {
  areCompletedMessagesEqual,
  isMessageCompleted,
} from "../server/utils/rooUtils";

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

  constructor(rooAdapter: RooCodeAdapter) {
    this.rooAdapter = rooAdapter;
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
  ): Promise<string> {
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

    const executeTaskWithSemaphore = async (taskQuery: string) => {
      await semaphore.acquire();
      try {
        await this.executeTask(taskQuery, run, streamContent, timeout);
      } finally {
        semaphore.release();
      }
    };

    // Execute all tasks concurrently with semaphore control
    await Promise.allSettled(
      taskQueries.map((taskQuery) => executeTaskWithSemaphore(taskQuery)),
    );

    logger.info(`Completed execution of ${taskQueries.length} RooCode tasks`);
    // return run;
    return this.summarizeRun(run);
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
    let taskId = "";
    let lastMessage: ClineMessage | undefined;
    let timeoutId: NodeJS.Timeout;

    const updateRunAndStream = async (id: string) => {
      if (streamContent) {
        await streamContent({
          type: "text",
          text: this.summarizeRun(run),
        });
      }
    };

    // Promise that resolves when task completes or fails
    const taskCompletionPromise = new Promise<void>((resolve, reject) => {
      // Set up timeout
      timeoutId = setTimeout(() => {
        if (run[taskId]) {
          run[taskId].status = "failed";
          run[taskId].result = "Task timed out after 5 minutes";
          updateRunAndStream(taskId);
        }
        reject(new Error("Task timeout"));
      }, timeout);

      // Create event handlers for this task
      const eventHandlers: TaskEventHandlers = {
        onMessage: async (id: string, message: any) => {
          if (!run[id]) {
            return;
          }

          if (areCompletedMessagesEqual(message, lastMessage)) {
            return; // Skip duplicate messages
          }

          if (isMessageCompleted(message)) {
            lastMessage = message;
          }

          if (message.say === "text" || message.say === "completion_result") {
            if (run[id].status === "created") {
              run[id].status = "running";
            }
            run[id].result = message.text;
            await updateRunAndStream(id);

            if (
              message.say === "completion_result" &&
              isMessageCompleted(message)
            ) {
              run[id].status = "completed";
              resolve();
            }
          }
        },

        onTaskCompleted: async (
          id: string,
          // tokenUsage: any,
          // toolUsage: any,
        ) => {
          clearTimeout(timeoutId);
          if (run[id]) {
            run[id].status = "completed";
            await updateRunAndStream(id);
          }
          resolve();
        },

        onTaskAborted: async (id: string) => {
          clearTimeout(timeoutId);
          if (run[id]) {
            run[id].status = "cancelled";
            run[id].result = "Task was cancelled";
            await updateRunAndStream(id);
          }
          resolve();
        },

        onTaskToolFailed: async (id: string, tool: string, error: string) => {
          clearTimeout(timeoutId);
          if (run[id]) {
            run[id].status = "failed";
            run[id].result = `Tool ${tool} failed: ${error}`;
            await updateRunAndStream(id);
          }
          resolve();
        },
      };

      // Start the task
      this.rooAdapter
        .startNewTask({
          text: `${taskQuery}\n\nThis is an automation task, do not ask any follow-up question.`,
          newTab: true,
          eventHandlers,
        })
        .then((id) => {
          taskId = id;
          run[taskId] = {
            task: taskQuery,
            status: "created",
            result: "Task created, waiting to start...",
          };
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          logger.error(`Failed to start RooCode task: ${taskQuery}`, error);

          const fallbackId = uuidv4();
          run[fallbackId] = {
            task: taskQuery,
            status: "failed",
            result: `Failed to start task: ${error.message}`,
          };

          updateRunAndStream(fallbackId);
          reject(error);
        });
    });

    return taskCompletionPromise;
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
