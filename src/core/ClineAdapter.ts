// import * as fs from "fs";
// import * as os from "os";
// import * as path from "path";
// import * as vscode from "vscode";

// import axios from "axios";
import { logger } from "../utils/logger";
import { ClineAPI } from "../types/cline";
import { ExtensionBaseAdapter } from "./ExtensionBaseAdapter";

// const ClineTestHost = "http://localhost:9876";

export interface ClineTaskOptions {
  task?: string;
  images?: string[];
}

/**
 * Dedicated adapter for Cline extension management
 * Handles Cline-specific logic including test mode setup and API interactions
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
   * Perform pre-activation setup
   */
  // protected async preActivation(): Promise<void> {
  //   await this.enableTestMode();
  // }

  /**
   * Perform post-activation setup
   */
  // protected async postActivation(): Promise<void> {
  //   // Verify test mode is working
  //   const isTestModeEnabled = await this.isTestModeEnabled();
  //   if (isTestModeEnabled) {
  //     logger.info("Cline extension activated with test mode enabled");
  //   } else {
  //     logger.warn(
  //       "Cline test mode is not enabled. Please ensure localhost:9876 is running.",
  //     );
  //   }
  // }

  /**
   * Enable Cline test mode by creating .tmp folder and evals.env file
   */
  // private async enableTestMode(): Promise<void> {
  //   try {
  //     let workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  //     let shouldOpenWorkspace = false;

  //     if (!workspaceUri) {
  //       workspaceUri = vscode.Uri.file(path.join(os.homedir(), ".tmp"));
  //       shouldOpenWorkspace = true;
  //     }

  //     const evalsEnvPath = path.join(workspaceUri.fsPath, "evals.env");

  //     // Create .tmp directory if it doesn't exist
  //     if (!fs.existsSync(workspaceUri.fsPath)) {
  //       fs.mkdirSync(workspaceUri.fsPath);
  //       logger.info("Created .tmp directory for Cline test mode");
  //     }

  //     // Create empty evals.env file if it doesn't exist
  //     if (!fs.existsSync(evalsEnvPath)) {
  //       fs.writeFileSync(evalsEnvPath, "");
  //       logger.info("Created evals.env file for Cline test mode");
  //     }

  //     if (shouldOpenWorkspace) {
  //       await vscode.commands.executeCommand("vscode.openFolder", workspaceUri);
  //     }
  //   } catch (error) {
  //     logger.error("Failed to enable Cline test mode:", error);
  //     throw error;
  //   }
  // }

  /**
   * Disable Cline test mode by shutting down the server and removing .tmp folder
   */
  // private async disableTestMode(): Promise<void> {
  //   try {
  //     // First, try to shutdown the local server
  //     await this.shutdownServer();

  //     const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  //     if (!workspaceFolder) {
  //       throw new Error("No workspace folder found");
  //     }

  //     const tmpDir = path.join(workspaceFolder.uri.fsPath, ".tmp");

  //     if (fs.existsSync(tmpDir)) {
  //       fs.rmSync(tmpDir, { recursive: true, force: true });
  //       logger.info("Removed .tmp directory");
  //     }
  //   } catch (error) {
  //     logger.error("Failed to disable Cline test mode:", error);
  //     throw error;
  //   }
  // }

  /**
   * Shutdown the Cline test server by calling the /shutdown endpoint
   */
  // private async shutdownServer(): Promise<void> {
  //   try {
  //     await axios.post(`${ClineTestHost}/shutdown`);
  //     logger.info("Cline test server shutdown request sent successfully");
  //   } catch (error) {
  //     logger.error("Cline test server shutdown failed:", JSON.stringify(error));
  //   }
  // }

  /**
   * Check if Cline test mode is enabled by testing if localhost:9876 is alive
   */
  // private async isTestModeEnabled(): Promise<boolean> {
  //   logger.info(`Checking ${ClineTestHost} status for Cline test mode`);
  //   try {
  //     await axios.get(ClineTestHost);
  //     return true;
  //   } catch (error) {
  //     if ((error as axios.AxiosError).code === "ECONNREFUSED") {
  //       return false;
  //     }
  //     return true;
  //   }
  // }

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
   * Start a new task by HTTP request
   */
  // async startNewTaskInTestMode(task: string, apiKey?: string): Promise<string> {
  //   if (!this.api) {
  //     throw new Error("Cline API not available");
  //   }

  //   logger.info("Starting new Cline task in test mode");
  //   await vscode.commands.executeCommand(
  //     "workbench.view.extension.claude-dev-ActivityBar",
  //   );

  //   const response = await axios.post(`${ClineTestHost}/task`, {
  //     task,
  //     apiKey,
  //   });
  //   if (response.status !== 200) {
  //     throw new Error(
  //       `Failed to start task in test mode: ${response.statusText}`,
  //     );
  //   }
  //   return response.data;
  // }

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
    // if (this.isActive) {
    //   await this.disableTestMode();
    // }
    this.isActive = false;
  }
}
