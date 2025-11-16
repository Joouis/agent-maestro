import * as vscode from "vscode";

import { logger } from "../utils/logger";

export function createCommandHandler(
  commandFunc: (...args: any[]) => Promise<void> | void,
  errorMessagePrefix: string,
) {
  return async (...args: any[]) => {
    try {
      await commandFunc(...args);
    } catch (error) {
      logger.error(`${errorMessagePrefix}: `, error);
      vscode.window.showErrorMessage(
        `${errorMessagePrefix}: ${(error as Error).message}`,
      );
    }
  };
}
