import { ClineAPI } from "../types/cline";
import { logger } from "../utils/logger";
import { ExtensionBaseAdapter } from "./ExtensionBaseAdapter";

export interface ClineTaskOptions {
  task?: string;
  images?: string[];
}

/**
 * Dedicated adapter for Cline extension management
 * Handles Cline-specific API interactions
 */
export class ClineAdapter extends ExtensionBaseAdapter<ClineAPI> {
  constructor() {
    super();
  }

  /**
   * Get the extension ID to discover
   */
  protected getExtensionId(): string {
    return "saoudrizwan.claude-dev";
  }

  /**
   * Get the display name for logging
   */
  protected getDisplayName(): string {
    return "ClineAdapter";
  }

  /**
   * Start a new task
   */
  async startNewTask(options: ClineTaskOptions = {}): Promise<void> {
    if (!this.api) {
      throw new Error("Cline API not available");
    }

    logger.info("Starting new Cline task");
    await this.api.startNewTask(options.task, options.images);
  }

  /**
   * Get custom instructions
   */
  async getCustomInstructions(): Promise<string | undefined> {
    if (!this.api) {
      throw new Error("Cline API not available");
    }

    return await this.api.getCustomInstructions();
  }

  /**
   * Set custom instructions
   */
  async setCustomInstructions(value: string): Promise<void> {
    if (!this.api) {
      throw new Error("Cline API not available");
    }

    await this.api.setCustomInstructions(value);
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    this.api = undefined;
    this.isActive = false;
  }
}
