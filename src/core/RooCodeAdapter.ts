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

export interface TaskEventHandlers {
  onMessage?: (taskId: string, message: any) => void;
  onTaskCreated?: (taskId: string) => void;
  onTaskStarted?: (taskId: string) => void;
  onTaskCompleted?: (taskId: string, tokenUsage: any, toolUsage: any) => void;
  onTaskAborted?: (taskId: string) => void;
  onTaskPaused?: (taskId: string) => void;
  onTaskUnpaused?: (taskId: string) => void;
  onTaskModeSwitched?: (taskId: string, mode: string) => void;
  onTaskSpawned?: (parentTaskId: string, childTaskId: string) => void;
  onTaskAskResponded?: (taskId: string) => void;
  onTaskTokenUsageUpdated?: (taskId: string, tokenUsage: any) => void;
  onTaskToolFailed?: (taskId: string, tool: string, error: string) => void;
}

export interface RooCodeMessageOptions {
  taskId?: string;
  text?: string;
  images?: string[];
  eventHandlers?: TaskEventHandlers;
}

export interface RooCodeTaskOptions extends RooCodeMessageOptions {
  configuration?: RooCodeSettings;
  newTab?: boolean;
}

export interface SendMessageOptions {
  taskId: string;
  eventHandlers?: TaskEventHandlers;
}

/**
 * Dedicated adapter for RooCode extension management
 * Handles RooCode-specific logic and API interactions
 */
export class RooCodeAdapter extends ExtensionBaseAdapter<RooCodeAPI> {
  private activeTaskHandlers: Map<string, TaskEventHandlers> = new Map();
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
   * Register global event listeners for logging and task handler forwarding
   */
  private registerGlobalEventListeners(): void {
    if (!this.api) {
      logger.error("RooCode API not available for event listeners");
      return;
    }

    // Forward events to task-specific handlers
    this.api.on(RooCodeEventName.Message, (data) => {
      logger.info("RooCode Message Event:", JSON.stringify(data, null, 2));
      this.forwardEventToTaskHandlers(
        data.taskId,
        "onMessage",
        data.taskId,
        data.message,
      );
    });

    this.api.on(RooCodeEventName.TaskCreated, (taskId) => {
      logger.info(`RooCode Task Created: ${taskId}`);
      this.forwardEventToTaskHandlers(taskId, "onTaskCreated", taskId);
    });

    this.api.on(RooCodeEventName.TaskStarted, (taskId) => {
      logger.info(`RooCode Task Started: ${taskId}`);
      this.forwardEventToTaskHandlers(taskId, "onTaskStarted", taskId);
    });

    this.api.on(
      RooCodeEventName.TaskCompleted,
      (taskId, tokenUsage, toolUsage) => {
        logger.info(`RooCode Task Completed: ${taskId}`, {
          tokenUsage,
          toolUsage,
        });
        this.forwardEventToTaskHandlers(
          taskId,
          "onTaskCompleted",
          taskId,
          tokenUsage,
          toolUsage,
        );
        // Clean up handlers when task is completed
        // Add a timeout to wait for unexpected occasional message events
        // setTimeout(() => {
        //   this.activeTaskHandlers.delete(taskId);
        // }, 3_000);
      },
    );

    this.api.on(RooCodeEventName.TaskAborted, (taskId) => {
      logger.info(`RooCode Task Aborted: ${taskId}`);
      this.forwardEventToTaskHandlers(taskId, "onTaskAborted", taskId);
      // Clean up handlers when task is aborted
      // this.activeTaskHandlers.delete(taskId);
    });

    this.api.on(RooCodeEventName.TaskPaused, (taskId) => {
      logger.info(`RooCode Task Paused: ${taskId}`);
      this.forwardEventToTaskHandlers(taskId, "onTaskPaused", taskId);
    });

    this.api.on(RooCodeEventName.TaskUnpaused, (taskId) => {
      logger.info(`RooCode Task Unpaused: ${taskId}`);
      this.forwardEventToTaskHandlers(taskId, "onTaskUnpaused", taskId);
    });

    this.api.on(RooCodeEventName.TaskModeSwitched, (taskId, mode) => {
      logger.info(`RooCode Task Mode Switched: ${taskId} -> ${mode}`);
      this.forwardEventToTaskHandlers(
        taskId,
        "onTaskModeSwitched",
        taskId,
        mode,
      );
    });

    this.api.on(RooCodeEventName.TaskSpawned, (parentTaskId, childTaskId) => {
      logger.info(`RooCode Task Spawned: ${parentTaskId} -> ${childTaskId}`);
      this.forwardEventToTaskHandlers(
        parentTaskId,
        "onTaskSpawned",
        parentTaskId,
        childTaskId,
      );
    });

    this.api.on(RooCodeEventName.TaskAskResponded, (taskId) => {
      logger.info(`RooCode Task Ask Responded: ${taskId}`);
      this.forwardEventToTaskHandlers(taskId, "onTaskAskResponded", taskId);
    });

    this.api.on(
      RooCodeEventName.TaskTokenUsageUpdated,
      (taskId, tokenUsage) => {
        logger.info(`RooCode Task Token Usage Updated: ${taskId}`, tokenUsage);
        this.forwardEventToTaskHandlers(
          taskId,
          "onTaskTokenUsageUpdated",
          taskId,
          tokenUsage,
        );
      },
    );

    this.api.on(RooCodeEventName.TaskToolFailed, (taskId, tool, error) => {
      logger.error(`RooCode Task Tool Failed: ${taskId} - ${tool}`, error);
      this.forwardEventToTaskHandlers(
        taskId,
        "onTaskToolFailed",
        taskId,
        tool,
        error,
      );
    });
  }

  /**
   * Forward events to task-specific handlers
   */
  private forwardEventToTaskHandlers(
    taskId: string,
    handlerName: keyof TaskEventHandlers,
    ...args: any[]
  ): void {
    const handlers = this.activeTaskHandlers.get(taskId);
    if (handlers && handlers[handlerName]) {
      try {
        (handlers[handlerName] as Function)(...args);
      } catch (error) {
        logger.error(
          `Error in task event handler ${handlerName} for task ${taskId}:`,
          error,
        );
      }
    }
  }

  /**
   * Start a new task
   */
  async startNewTask(options: RooCodeTaskOptions = {}): Promise<string> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Starting new RooCode task");

    // Extract event handlers from options before passing to API
    const { eventHandlers, ...apiOptions } = options;

    // Start the task
    const taskId = await this.api.startNewTask(apiOptions);

    // Register event handlers for this specific task
    if (eventHandlers && taskId) {
      this.activeTaskHandlers.set(taskId, eventHandlers);
      logger.info(`Registered event handlers for task: ${taskId}`);
    }

    return taskId;
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
   * Send message to current task
   */
  async sendMessage(
    message?: string,
    images?: string[],
    options?: SendMessageOptions,
  ): Promise<void> {
    if (!this.api) {
      throw new Error("RooCode API not available");
    }

    logger.info("Sending message to RooCode current task");

    // Extract event handlers from options before passing to API
    const { eventHandlers, taskId } = options || {};

    // Send the message
    await this.api.sendMessage(message, images);

    // Register event handlers for this specific task if provided
    if (eventHandlers && taskId) {
      this.activeTaskHandlers.set(taskId, eventHandlers);
      logger.info(`Registered event handlers for task: ${taskId}`);
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
   * Get active task IDs that have event handlers
   */
  getActiveTaskIds(): string[] {
    return Array.from(this.activeTaskHandlers.keys());
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
