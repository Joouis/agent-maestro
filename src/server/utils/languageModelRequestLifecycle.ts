import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import {
  ThinkingPart,
  hasEncryptedThinking,
  isThinkingPart,
} from "./languageModelThinking";

export const LANGUAGE_MODEL_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export class LanguageModelRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Language model request timed out after ${timeoutMs}ms`);
    this.name = "LanguageModelRequestTimeoutError";
  }
}

export class LanguageModelClientDisconnectedError extends Error {
  constructor() {
    super("Language model request cancelled because the client disconnected");
    this.name = "LanguageModelClientDisconnectedError";
  }
}

export class LanguageModelRequestLifecycle {
  private readonly cancellationTokenSource =
    new vscode.CancellationTokenSource();
  private readonly abortController = new AbortController();
  private interruption: Error | undefined;
  private readonly interruptionWaiters = new Set<(error: Error) => void>();
  private readonly timeout: NodeJS.Timeout;
  private disposed = false;

  private readonly handleClientAbort = () => {
    this.interrupt(new LanguageModelClientDisconnectedError());
  };

  constructor(
    private readonly clientSignal: AbortSignal,
    timeoutMs: number = LANGUAGE_MODEL_REQUEST_TIMEOUT_MS,
  ) {
    this.timeout = setTimeout(() => {
      this.interrupt(new LanguageModelRequestTimeoutError(timeoutMs));
    }, timeoutMs);
    this.timeout.unref();

    if (clientSignal.aborted) {
      this.handleClientAbort();
    } else {
      clientSignal.addEventListener("abort", this.handleClientAbort, {
        once: true,
      });
    }
  }

  get token(): vscode.CancellationToken {
    return this.cancellationTokenSource.token;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  async waitFor<T>(operation: PromiseLike<T>): Promise<T> {
    if (this.interruption) {
      throw this.interruption;
    }

    return new Promise<T>((resolve, reject) => {
      const rejectOnInterruption = (error: Error) => reject(error);
      this.interruptionWaiters.add(rejectOnInterruption);

      Promise.resolve(operation).then(
        (value) => {
          this.interruptionWaiters.delete(rejectOnInterruption);
          resolve(value);
        },
        (error) => {
          this.interruptionWaiters.delete(rejectOnInterruption);
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    clearTimeout(this.timeout);
    this.clientSignal.removeEventListener("abort", this.handleClientAbort);
    this.interruptionWaiters.clear();
    this.cancellationTokenSource.dispose();
  }

  private interrupt(error: Error): void {
    if (this.interruption || this.disposed) {
      return;
    }

    this.interruption = error;
    this.abortController.abort(error);
    this.cancellationTokenSource.cancel();
    for (const reject of this.interruptionWaiters) {
      reject(error);
    }
    this.interruptionWaiters.clear();
  }
}

export async function* interruptibleLanguageModelStream<T>(
  stream: AsyncIterable<T>,
  lifecycle: LanguageModelRequestLifecycle,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();

  while (true) {
    const result = await lifecycle.waitFor(iterator.next());
    if (result.done) {
      return;
    }

    yield result.value;
  }
}

export async function* requestLanguageModelWithEmptyResponseRetry(
  client: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  options: vscode.LanguageModelChatRequestOptions,
  lifecycle: LanguageModelRequestLifecycle,
  isIncompleteResponseError?: (error: unknown) => boolean,
): AsyncGenerator<unknown> {
  for (let attempt = 0; ; attempt++) {
    let committedOutput = false;
    const pendingThinking: ThinkingPart[] = [];
    try {
      if (lifecycle.signal.aborted) {
        throw lifecycle.signal.reason;
      }
      const response = await lifecycle.waitFor(
        client.sendRequest(messages, options, lifecycle.token),
      );
      for await (const part of interruptibleLanguageModelStream(
        response.stream,
        lifecycle,
      )) {
        // Keep opaque-only reasoning private until this attempt can be committed.
        if (
          !committedOutput &&
          client.vendor === "copilot" &&
          isThinkingPart(part) &&
          hasEncryptedThinking(part) &&
          (part.value === "" ||
            (Array.isArray(part.value) &&
              part.value.every((value) => value === "")))
        ) {
          pendingThinking.push(part);
          continue;
        }
        committedOutput = true;
        yield* pendingThinking;
        pendingThinking.length = 0;
        yield part;
      }
      yield* pendingThinking;
      return;
    } catch (error) {
      if (lifecycle.signal.aborted) {
        throw lifecycle.signal.reason;
      }
      if (isIncompleteResponseError?.(error)) {
        yield* pendingThinking;
        throw error;
      }
      // Never replay text, tools, visible thinking, usage, or unknown parts.
      if (
        attempt !== 0 ||
        committedOutput ||
        client.vendor !== "copilot" ||
        !(error instanceof Error) ||
        error.message !== "Response contained no choices."
      ) {
        throw error;
      }
      logger.warn(
        `Copilot returned no choices before committing response output; retrying once after 250ms (model: ${client.id})`,
      );
      await delay(250, undefined, { signal: lifecycle.signal }).catch(
        (error: unknown) => {
          throw lifecycle.signal.aborted ? lifecycle.signal.reason : error;
        },
      );
    }
  }
}
