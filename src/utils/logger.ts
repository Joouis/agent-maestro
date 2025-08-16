import packageJson from "../../package.json";
import * as vscode from "vscode";

export class Logger {
  private readonly outputChannel: vscode.LogOutputChannel;

  constructor(channelName: string) {
    this.outputChannel = vscode.window.createOutputChannel(channelName, {
      log: true,
    });
  }

  /**
   * Log an info message
   */
  info(message: string, ...args: any[]): void {
    this.outputChannel.info(message, ...args);
  }

  /**
   * Log a warning message
   */
  warn(message: string, ...args: any[]): void {
    this.outputChannel.warn(message, ...args);
  }

  /**
   * Log an error message
   */
  error(message: string | Error, ...args: any[]): void {
    this.outputChannel.error(message, ...args);
  }

  /**
   * Log a debug message
   */
  debug(message: string, ...args: any[]): void {
    this.outputChannel.debug(message, ...args);
  }

  /**
   * Log a trace message
   */
  trace(message: string, ...args: any[]): void {
    this.outputChannel.trace(message, ...args);
  }

  /**
   * Removes all output from the channel.
   */
  clear(): void {
    this.outputChannel.clear();
  }

  /**
   * Dispose and free associated resources.
   */
  dispose(): void {
    this.outputChannel.dispose();
  }

  /**
   * Reveal this channel in the UI.
   */
  show(preserveFocus?: boolean): void {
    this.outputChannel.show(preserveFocus);
  }

  /**
   * Hide this channel from the UI.
   */
  hide(): void {
    this.outputChannel.hide();
  }
}

export const logger = new Logger(packageJson.displayName || "Agent Maestro");
