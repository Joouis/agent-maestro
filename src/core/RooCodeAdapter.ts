import { logger } from "../utils/logger";
import {
  RooCodeAPI,
  RooCodeSettings,
  ProviderSettings,
  ProviderSettingsEntry,
  RooCodeEventName,
  HistoryItem,
} from "@roo-code/types";
import { Anthropic } from "@anthropic-ai/sdk";
import { ExtensionBaseAdapter } from "./ExtensionBaseAdapter";
import { TaskEvent } from "../server/types";

export interface RooCodeMessageOptions {
  taskId?: string;
  text?: string;
  images?: string[];
}

export interface RooCodeTaskOptions extends RooCodeMessageOptions {
  configuration?: RooCodeSettings;
  newTab?: boolean;
}

export interface SendMessageOptions {
  taskId: string;
}

/**
 * Dedicated adapter for RooCode extension management
 * Handles RooCode-specific logic and API interactions
 */
export class RooCodeAdapter extends ExtensionBaseAdapter<RooCodeAPI> {
  private taskEventQueues: Map<string, TaskEvent[]> = new Map();
  private taskEventResolvers: Map<string, ((event: TaskEvent) => void)[]> =
    new Map();
  private extensionId: string;

  constructor(extensionId: string) {
    super();
    this.extensionId = extensionId;
  }

  /**
   * Get the extension ID to discover
   */
  protected getExtensionId(): string {
    return this.extensionId;
  }

  /**
   * Perform any post-activation setup
   */
  protected async postActivation(): Promise<void> {
    this.registerGlobalEventListeners();
  }

  /**
   * Activate extension with force activation
   */
  protected async activateExtension(): Promise<void> {
    await super.activateExtension(true);
  }

  /**
   * Register global event listeners for event queuing
   */
  private registerGlobalEventListeners(): void {
    if (!this.api) {
      logger.error("RooCode API not available for event listeners");
      return;
    }

    this.api.on(RooCodeEventName.Message, (data) => {
      logger.info("RooCode Message Event:", JSON.stringify(data, null, 2));
      this.enqueueEvent(data.taskId, {
        name: RooCodeEventName.Message,
        data,
      });
    });

    this.api.on(RooCodeEventName.TaskCreated, (taskId) => {
      logger.info(`RooCode Task Created: ${taskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskCreated,
        data: {
          taskId,
        },
      });
    });

    this.api.on(RooCodeEventName.TaskStarted, (taskId) => {
      logger.info(`RooCode Task Started: ${taskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskStarted,
        data: {
          taskId,
        },
      });
    });

    this.api.on(
      RooCodeEventName.TaskCompleted,
      (taskId, tokenUsage, toolUsage) => {
        logger.info(`RooCode Task Completed: ${taskId}`, {
          tokenUsage,
          toolUsage,
        });
        this.enqueueEvent(taskId, {
          name: RooCodeEventName.TaskCompleted,
          data: {
            taskId,
            tokenUsage,
            toolUsage,
          },
        });
      },
    );

    this.api.on(RooCodeEventName.TaskAborted, (taskId) => {
      logger.info(`RooCode Task Aborted: ${taskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskAborted,
        data: {
          taskId,
        },
      });
    });

    this.api.on(RooCodeEventName.TaskPaused, (taskId) => {
      logger.info(`RooCode Task Paused: ${taskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskPaused,
        data: {
          taskId,
        },
      });
    });

    this.api.on(RooCodeEventName.TaskUnpaused, (taskId) => {
      logger.info(`RooCode Task Unpaused: ${taskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskUnpaused,
        data: {
          taskId,
        },
      });
    });

    this.api.on(RooCodeEventName.TaskModeSwitched, (taskId, mode) => {
      logger.info(`RooCode Task Mode Switched: ${taskId} -> ${mode}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskModeSwitched,
        data: {
          taskId,
          mode,
        },
      });
    });

    this.api.on(RooCodeEventName.TaskSpawned, (taskId, childTaskId) => {
      logger.info(`RooCode Task Spawned: ${taskId} -> ${childTaskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskSpawned,
        data: {
          taskId,
          childTaskId,
        },
      });
    });

    this.api.on(RooCodeEventName.TaskAskResponded, (taskId) => {
      logger.info(`RooCode Task Ask Responded: ${taskId}`);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskAskResponded,
        data: {
          taskId,
        },
      });
    });

    this.api.on(
      RooCodeEventName.TaskTokenUsageUpdated,
      (taskId, tokenUsage) => {
        logger.info(`RooCode Task Token Usage Updated: ${taskId}`, tokenUsage);
        this.enqueueEvent(taskId, {
          name: RooCodeEventName.TaskTokenUsageUpdated,
          data: {
            taskId,
            tokenUsage,
          },
        });
      },
    );

    this.api.on(RooCodeEventName.TaskToolFailed, (taskId, tool, error) => {
      logger.error(`RooCode Task Tool Failed: ${taskId} - ${tool}`, error);
      this.enqueueEvent(taskId, {
        name: RooCodeEventName.TaskToolFailed,
        data: {
          taskId,
          tool,
          error,
        },
      });
    });
  }

  /**
   * Enqueue event for async generators
   */
  private enqueueEvent(taskId: string, event: TaskEvent): void {
    // Check if there are waiting resolvers first
    const resolvers = this.taskEventResolvers.get(taskId);
    if (resolvers && resolvers.length > 0) {
      // Immediately resolve to waiting resolver - don't queue
      const resolver = resolvers.shift()!;
      resolver(event);
      return;
    }

    // Only add to queue if no resolvers are waiting
    if (!this.taskEventQueues.has(taskId)) {
      this.taskEventQueues.set(taskId, []);
    }
    this.taskEventQueues.get(taskId)!.push(event);
  }

  /**
   * Create async generator for task events
   */
  private async *createTaskEventStream(
    taskId: string,
  ): AsyncGenerator<TaskEvent, void, unknown> {
    try {
      while (true) {
        // Check if there are queued events
        const queue = this.taskEventQueues.get(taskId);
        if (queue && queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (this.isTerminalEvent(event)) {
            break; // Close stream on terminal event
          }
          continue;
        }

        // Wait for next event
        const event = await new Promise<TaskEvent>((resolve) => {
          if (!this.taskEventResolvers.has(taskId)) {
            this.taskEventResolvers.set(taskId, []);
          }
          this.taskEventResolvers.get(taskId)!.push(resolve);
        });

        yield event;
        if (this.isTerminalEvent(event)) {
          break; // Close stream on terminal event
        }
      }
    } finally {
      this.cleanupTaskStream(taskId);
    }
  }

  /**
   * Check if event type is terminal (ends the stream)
   */
  private isTerminalEvent(event: TaskEvent): boolean {
    if (event.name === RooCodeEventName.Message) {
      const { message } = (event as TaskEvent<RooCodeEventName.Message>).data;
      if (!message.partial) {
        // Close stream if Roo is waiting for follow-up or result completed
        if (message.ask === "followup" || message.say === "completion_result") {
          return true;
        }
      }
    }

    // Ignore TaskCompleted event by design since "completion_result" messages are not finished yet
    return event.name === RooCodeEventName.TaskAborted;
  }

  /**
   * Cleanup task event stream resources
   */
  private cleanupTaskStream(taskId: string): void {
    this.taskEventQueues.delete(taskId);
    this.taskEventResolvers.delete(taskId);
  }

  /**
   * Start a new task and return async generator for events
   */
  async *startNewTask(
    options: RooCodeTaskOptions = {},
  ): AsyncGenerator<TaskEvent, void, unknown> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Starting new RooCode task");

    try {
      // Start the task
      const taskId = await this.api.startNewTask(options);

      // Create and yield from event stream
      yield* this.createTaskEventStream(taskId);
    } catch (error) {
      logger.error("Error starting new RooCode task:", error);
      throw error;
    }
  }

  /**
   * Resume a task
   */
  async resumeTask(taskId: string): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Resuming RooCode task: ${taskId}`);
    await this.api.resumeTask(taskId);

    // Check if task appears in clineStack with interval since it may take a few milliseconds
    return new Promise<void>((resolve, reject) => {
      const maxAttempts = 50; // 5 seconds total (50 * 100ms)
      let attempts = 0;

      const checkInterval = setInterval(() => {
        attempts++;

        try {
          const clineStack = (this.api as any).sidebarProvider?.clineStack;
          if (clineStack && Array.isArray(clineStack)) {
            const taskExists = clineStack.some(
              (item: any) => item.taskId === taskId,
            );
            if (taskExists) {
              logger.info(
                `Task ${taskId} found in clineStack after ${attempts * 100}ms`,
              );
              clearInterval(checkInterval);
              resolve();
              return;
            }
          }

          if (attempts >= maxAttempts) {
            logger.warn(
              `Task ${taskId} not found in clineStack after ${maxAttempts * 100}ms`,
            );
            clearInterval(checkInterval);
            resolve(); // Still resolve to not break the flow
          }
        } catch (error) {
          logger.error(`Error checking clineStack for task ${taskId}:`, error);
          clearInterval(checkInterval);
          reject(error);
        }
      }, 100); // Check every 100ms
    });
  }

  /**
   * Check if task is in history
   */
  async isTaskInHistory(taskId: string): Promise<boolean> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return await this.api.isTaskInHistory(taskId);
  }

  /**
   * Get current task stack
   */
  getCurrentTaskStack(): string[] {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return this.api.getCurrentTaskStack();
  }

  /**
   * Clear current task
   */
  async clearCurrentTask(lastMessage?: string): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Clearing RooCode current task");
    await this.api.clearCurrentTask(lastMessage);
  }

  /**
   * Cancel current task
   */
  async cancelCurrentTask(): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Canceling RooCode current task");
    await this.api.cancelCurrentTask();
  }

  /**
   * Send message to current task and return async generator for events
   */
  async *sendMessage(
    message?: string,
    images?: string[],
    options?: SendMessageOptions,
  ): AsyncGenerator<TaskEvent, void, unknown> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Sending message to RooCode current task");

    try {
      const { taskId } = options || {};

      // Send the message
      await this.api.sendMessage(message, images);

      // If taskId is provided, create event stream for that specific task
      if (taskId) {
        yield* this.createTaskEventStream(taskId);
      }
    } catch (error) {
      logger.error("Error sending message to RooCode task:", error);
      throw error;
    }
  }

  /**
   * Press primary button in chat interface
   */
  async pressPrimaryButton(): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Pressing RooCode primary button");
    await this.api.pressPrimaryButton();
  }

  /**
   * Press secondary button in chat interface
   */
  async pressSecondaryButton(): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Pressing RooCode secondary button");
    await this.api.pressSecondaryButton();
  }

  /**
   * Check if API is ready to use
   */
  isReady(): boolean {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return this.api.isReady();
  }

  /**
   * Get configuration
   */
  getConfiguration(): RooCodeSettings {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return this.api.getConfiguration();
  }

  /**
   * Set configuration
   */
  async setConfiguration(values: RooCodeSettings): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    await this.api.setConfiguration(values);
  }

  /**
   * Get profiles
   */
  getProfiles(): string[] {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return this.api.getProfiles();
  }

  /**
   * Get profile entry by name
   */
  getProfileEntry(name: string): ProviderSettingsEntry | undefined {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return this.api.getProfileEntry(name);
  }

  /**
   * Create a new API configuration profile
   */
  async createProfile(
    name: string,
    profile?: ProviderSettings,
    activate?: boolean,
  ): Promise<string> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Creating RooCode profile: ${name}`);
    return await this.api.createProfile(name, profile, activate);
  }

  /**
   * Get active task IDs that have event streams
   */
  getActiveTaskIds(): string[] {
    return Array.from(this.taskEventQueues.keys());
  }

  /**
   * Update an existing API configuration profile
   */
  async updateProfile(
    name: string,
    profile: ProviderSettings,
    activate?: boolean,
  ): Promise<string | undefined> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Updating RooCode profile: ${name}`);
    return await this.api.updateProfile(name, profile, activate);
  }

  /**
   * Create or update an API configuration profile
   */
  async upsertProfile(
    name: string,
    profile: ProviderSettings,
    activate?: boolean,
  ): Promise<string | undefined> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Upserting RooCode profile: ${name}`);
    return await this.api.upsertProfile(name, profile, activate);
  }

  /**
   * Delete a profile by name
   */
  async deleteProfile(name: string): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Deleting RooCode profile: ${name}`);
    await this.api.deleteProfile(name);
  }

  /**
   * Get active profile
   */
  getActiveProfile(): string | undefined {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    return this.api.getActiveProfile();
  }

  /**
   * Set active profile
   */
  async setActiveProfile(name: string): Promise<string | undefined> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Setting RooCode active profile: ${name}`);
    return await this.api.setActiveProfile(name);
  }

  /**
   * Get task history
   */
  getTaskHistory(): HistoryItem[] {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Retrieving RooCode task history");
    const configuration = this.api.getConfiguration();
    const taskHistory = configuration.taskHistory || [];
    logger.info(`Retrieved ${taskHistory.length} task history items`);
    return taskHistory;
  }

  /**
   * Get task details by task ID
   */
  async getTaskWithId(taskId: string): Promise<{
    historyItem: HistoryItem;
    taskDirPath: string;
    apiConversationHistoryFilePath: string;
    uiMessagesFilePath: string;
    apiConversationHistory: Anthropic.MessageParam[];
  }> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info(`Getting task with ID: ${taskId}`);
    return await (this.api as any).sidebarProvider.getTaskWithId(taskId);
  }

  /**
   * Cleanup resources and remove event listeners
   */
  async dispose(): Promise<void> {
    if (this.api) {
      // Remove all event listeners
      this.api.removeAllListeners();
    }

    await super.dispose();
  }
}
