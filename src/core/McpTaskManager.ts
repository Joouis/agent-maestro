import { RooCodeEventName } from "@roo-code/types";
import { isEqual, Semaphore } from "es-toolkit";
// @ts-expect-error "TS1479: The current file is a CommonJS module"
import type { Content } from "fastmcp";
import { logger } from "../utils/logger";
import { RooCodeAdapter } from "./RooCodeAdapter";
import { TaskEvent } from "../server/types";
import { v4 as uuidv4 } from "uuid";
import { closeAllEmptyTabGroups } from "../utils/extension";

export interface TaskRun {
  task: string;
  status: "created" | "running" | "completed" | "failed" | "cancelled";
  result: string;
}

export interface ExecuteRooTasksOptions {
  maxConcurrency?: number;
  streamContent?: (content: Content | Content[]) => Promise<void>;
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

    const { maxConcurrency = 3, streamContent } = options;

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

    // Execute all tasks concurrently with semaphore control
    await Promise.allSettled(
      taskQueries.map(async (taskQuery, idx) => {
        await semaphore.acquire();
        try {
          /**
           * executeRooTasks will launch the max number of tasks at same time,
           * however this will trigger a bug in Roo Code that create multiple empty editor groups.
           * We have to wait the first startNewTask returns task id then launch other tasks.
           */
          const onTaskCreated =
            idx === maxConcurrency - 1 || idx === taskQueries.length - 1
              ? async () => {
                  await closeAllEmptyTabGroups();
                }
              : undefined;
          await this.executeTask(taskQuery, run, streamContent, onTaskCreated);
        } finally {
          semaphore.release();
        }
      }),
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
    streamContent?: (content: Content | Content[]) => Promise<void>,
    onTaskCreated?: (taskId: string) => void,
  ): Promise<void> {
    let taskId = "";

    const updateRunAndStream = async (id: string) => {
      if (streamContent) {
        await streamContent({
          type: "text",
          text: this.summarizeRun(run),
        });
      }
    };

    try {
      // Start the task and get the async generator
      const taskEventStream = this.rooAdapter.startNewTask({
        text: `${taskQuery}\n\nThis is an automation task, do not ask any follow-up question.`,
        newTab: true,
      });

      let lastEvent: TaskEvent | undefined;
      // Process events from the async generator
      for await (const event of taskEventStream) {
        if (isEqual(event, lastEvent)) {
          continue; // Skip duplicate events
        }
        if (!taskId) {
          taskId = event.data.taskId;
        }
        lastEvent = event;

        // Handle TaskCreated event to get the task ID
        if (event.name === RooCodeEventName.TaskCreated) {
          run[taskId] = {
            task: taskQuery,
            status: "created",
            result: "Task created, waiting to start...",
          };

          if (onTaskCreated) {
            onTaskCreated(taskId);
          }
          await updateRunAndStream(taskId);
        }
        // Handle Message events
        else if (event.name === RooCodeEventName.Message) {
          if (!run[taskId]) {
            continue;
          }

          const { message } = (event as TaskEvent<RooCodeEventName.Message>)
            .data;
          if (message.say === "text" || message.say === "completion_result") {
            if (run[taskId].status === "created") {
              run[taskId].status = "running";
            }
            run[taskId].result = message.text ?? "";
            await updateRunAndStream(taskId);

            if (message.say === "completion_result" && !message.partial) {
              run[taskId].status = "completed";
              return;
            }
          }
        }
        // Handle TaskCompleted event
        else if (event.name === RooCodeEventName.TaskCompleted) {
          if (run[taskId]) {
            run[taskId].status = "completed";
            await updateRunAndStream(taskId);
          }
          return;
        }
        // Handle TaskAborted event
        else if (event.name === RooCodeEventName.TaskAborted) {
          if (run[taskId]) {
            run[taskId].status = "cancelled";
            run[taskId].result = "Task was cancelled";
            await updateRunAndStream(taskId);
          }
          return;
        }
        // Handle TaskToolFailed event
        else if (event.name === RooCodeEventName.TaskToolFailed) {
          if (run[taskId]) {
            const { data } =
              event as TaskEvent<RooCodeEventName.TaskToolFailed>;
            run[taskId].status = "failed";
            run[taskId].result = `Tool ${data.tool} failed: ${data.error}`;
            await updateRunAndStream(taskId);
          }
          return;
        }
      }
    } catch (error) {
      logger.error(`Failed to start RooCode task: ${taskQuery}`, error);

      const fallbackId = taskId || uuidv4();
      run[fallbackId] = {
        task: taskQuery,
        status: "failed",
        result: `Failed to start task: ${(error as Error).message}`,
      };

      await updateRunAndStream(fallbackId);
      throw error;
    }
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
