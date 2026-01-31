import { EventEmitter } from "events";
import * as vscode from "vscode";

import {
  AgentMaestroConfiguration,
  DEFAULT_CONFIG,
  readConfiguration,
} from "../utils/config";
import { logger } from "../utils/logger";
import { ExtensionStatus } from "../utils/systemInfo";
import { ClineAdapter } from "./ClineAdapter";
import { RooCodeAdapter } from "./RooCodeAdapter";

/**
 * Core controller to manage Cline and RooCode extensions
 * Provides unified API access and can be used by both VSCode extension and local server
 */
export class ExtensionController extends EventEmitter {
  public readonly clineAdapter: ClineAdapter;
  public readonly rooAdapterMap: Map<string, RooCodeAdapter> = new Map();
  private currentConfig: AgentMaestroConfiguration = readConfiguration();
  public isInitialized = false;

  constructor() {
    super();
    this.clineAdapter = new ClineAdapter();

    // Initialize RooCode adapters with current configuration
    this.initializeRooAdapters(this.currentConfig);
  }

  /**
   * Initialize RooCode adapters for default and variant identifiers
   */
  private initializeRooAdapters(config: AgentMaestroConfiguration): void {
    // Check and create adapter for default RooCode extension
    if (this.isExtensionInstalled(config.defaultRooIdentifier)) {
      const defaultAdapter = new RooCodeAdapter(config.defaultRooIdentifier);
      this.rooAdapterMap.set(config.defaultRooIdentifier, defaultAdapter);
      logger.info(`Added RooCode adapter for: ${config.defaultRooIdentifier}`);
    } else {
      logger.warn(`Extension not found: ${config.defaultRooIdentifier}`);
    }

    // Check and create adapters for each variant identifier
    for (const identifier of new Set([
      ...config.rooVariantIdentifiers,
      DEFAULT_CONFIG.defaultRooIdentifier,
    ])) {
      if (
        identifier !== config.defaultRooIdentifier &&
        this.isExtensionInstalled(identifier)
      ) {
        const adapter = new RooCodeAdapter(identifier);
        this.rooAdapterMap.set(identifier, adapter);
        logger.info(`Added RooCode adapter for: ${identifier}`);
      } else if (identifier !== config.defaultRooIdentifier) {
        logger.warn(`Extension not found: ${identifier}`);
      }
    }
  }

  /**
   * Check if extension is installed
   */
  private isExtensionInstalled(extensionId: string): boolean {
    return !!vscode.extensions.getExtension(extensionId);
  }

  /**
   * Get RooCode adapter for specific extension ID
   */
  getRooAdapter(extensionId?: string): RooCodeAdapter | undefined {
    return this.rooAdapterMap.get(
      extensionId || this.currentConfig.defaultRooIdentifier,
    );
  }

  /**
   * Initialize the controller by discovering and activating extensions
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info("Controller already initialized");
      return;
    }

    // Initialize ClineAdapter
    await this.clineAdapter.initialize();

    // Initialize all RooCode adapters
    for (const adapter of this.rooAdapterMap.values()) {
      await adapter.initialize();
    }

    // Check if at least one adapter is active
    const hasActiveAdapter =
      this.clineAdapter.isActive ||
      Array.from(this.rooAdapterMap.values()).some(
        (adapter) => adapter.isActive,
      );

    if (!hasActiveAdapter) {
      logger.warn(
        "No active extension found. This may be due to missing installations or activation issues.",
      );
    }

    this.isInitialized = true;
    logger.info("Extension controller initialized successfully");
  }

  /**
   * Get status of extensions
   */
  getExtensionStatus(): Record<string, ExtensionStatus> {
    const status: Record<string, ExtensionStatus> = {} as Record<
      string,
      ExtensionStatus
    >;

    // Cline status
    status["cline"] = {
      isInstalled: this.clineAdapter.isInstalled(),
      isActive: this.clineAdapter.isActive,
      version: this.clineAdapter.getVersion(),
    };

    // Roo variants status
    for (const [extensionId, adapter] of this.rooAdapterMap) {
      status[extensionId] = {
        isInstalled: adapter?.isInstalled() ?? false,
        isActive: adapter?.isActive ?? false,
        version: adapter?.getVersion(),
      };
    }

    return status;
  }

  /**
   * Cleanup resources
   */
  async dispose(): Promise<void> {
    this.removeAllListeners();
    this.isInitialized = false;

    await this.clineAdapter.dispose();

    // Dispose all RooCode adapters
    for (const adapter of this.rooAdapterMap.values()) {
      await adapter.dispose();
    }
    this.rooAdapterMap.clear();
  }
}
