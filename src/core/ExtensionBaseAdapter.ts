import * as vscode from "vscode";

import { logger } from "../utils/logger";

/**
 * Extension base adapter class providing common functionality for extension adapters
 * Handles extension discovery, activation, and common API operations
 */
export abstract class ExtensionBaseAdapter<TApi = any> {
  protected extension: vscode.Extension<any> | undefined;
  public api: TApi | undefined;
  public isActive = false;

  constructor() {}

  /**
   * Get the extension ID to discover
   */
  protected abstract getExtensionId(): string;

  /**
   * Get the display name for logging
   */
  protected getDisplayName(): string {
    return `"${this.getExtensionId()}" Adapter`;
  }

  /**
   * Perform any pre-activation setup
   */
  protected async preActivation(): Promise<void> {
    // Default implementation does nothing
    // Subclasses can override for specific setup
  }

  /**
   * Perform any post-activation setup
   */
  protected async postActivation(): Promise<void> {
    // Default implementation does nothing
    // Subclasses can override for specific setup
  }

  /**
   * Initialize the adapter
   */
  async initialize(): Promise<void> {
    if (this.isActive) {
      logger.info(`${this.getDisplayName()} already activated`);
      return;
    }

    try {
      await this.discoverExtension();
      await this.activateExtension();

      this.isActive = true;
      logger.info(`${this.getDisplayName()} activated successfully`);
    } catch (error) {
      logger.warn(`Failed to initialize ${this.getDisplayName()}:`, error);
    }
  }

  /**
   * Discover extension
   */
  protected async discoverExtension(): Promise<void> {
    this.extension = vscode.extensions.getExtension(this.getExtensionId());

    if (this.extension) {
      logger.info(
        `Found ${this.getDisplayName()} v${this.extension.packageJSON.version}`,
      );
    } else {
      throw new Error(
        `${this.getDisplayName()} not found. Please install ${this.getDisplayName()}.`,
      );
    }
  }

  /**
   * Activate extension
   */
  protected async activateExtension(
    forceActivate: boolean = false,
  ): Promise<void> {
    if (!this.extension) {
      throw new Error(`${this.getDisplayName()} not discovered`);
    }

    // Perform pre-activation setup
    await this.preActivation();

    if (!this.extension.isActive || forceActivate) {
      try {
        this.api = await this.extension.activate();
      } catch (error) {
        logger.error(`Failed to activate ${this.getDisplayName()}:`, error);
        throw error;
      }
    } else {
      this.api = this.extension.exports;
      logger.info(`${this.getDisplayName()} already active`);
    }

    // Perform post-activation setup
    await this.postActivation();
  }

  /**
   * Press primary button
   */
  async pressPrimaryButton(): Promise<void> {
    if (!this.api) {
      throw new Error(`${this.getDisplayName()} API not available`);
    }

    logger.info(`Pressing ${this.getDisplayName()} primary button`);
    await (this.api as any).pressPrimaryButton();
  }

  /**
   * Press secondary button
   */
  async pressSecondaryButton(): Promise<void> {
    if (!this.api) {
      throw new Error(`${this.getDisplayName()} API not available`);
    }

    logger.info(`Pressing ${this.getDisplayName()} secondary button`);
    await (this.api as any).pressSecondaryButton();
  }

  /**
   * Check if extension is installed
   */
  isInstalled(): boolean {
    return !!this.extension;
  }

  /**
   * Get extension version
   */
  getVersion(): string | undefined {
    return this.extension?.packageJSON.version;
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    this.api = undefined;
    this.isActive = false;
  }
}
