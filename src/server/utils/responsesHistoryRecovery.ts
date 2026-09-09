import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
  interruptibleLanguageModelStream,
} from "./languageModelRequestLifecycle";

function isPairedFailure(
  error: unknown,
  messages: vscode.LanguageModelChatMessage[],
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const match =
    /No tool call found for function call output with call_id ([A-Za-z0-9_-]+)/.exec(
      error.message,
    );
  if (!match) {
    return false;
  }
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        if (
          message.role !== vscode.LanguageModelChatMessageRole.Assistant ||
          !part.callId ||
          calls.has(part.callId)
        ) {
          return false;
        }
        calls.add(part.callId);
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (
          message.role !== vscode.LanguageModelChatMessageRole.User ||
          !calls.has(part.callId) ||
          results.has(part.callId)
        ) {
          return false;
        }
        if (
          part.content.some(
            (item) =>
              !(item instanceof vscode.LanguageModelTextPart) &&
              !(item instanceof vscode.LanguageModelDataPart),
          )
        ) {
          return false;
        }
        results.add(part.callId);
      }
    }
  }
  return (
    calls.has(match[1]) && results.has(match[1]) && calls.size === results.size
  );
}

function historyAsContext(
  messages: vscode.LanguageModelChatMessage[],
): vscode.LanguageModelChatMessage[] {
  return messages.map((message) => {
    const content: vscode.LanguageModelChatMessage["content"] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        content.push(
          new vscode.LanguageModelTextPart(
            "[Completed historical tool call; context only, do not execute again] " +
              JSON.stringify({
                call_id: part.callId,
                name: part.name,
                input: part.input,
              }),
          ),
        );
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        content.push(
          new vscode.LanguageModelTextPart(
            "[Historical tool output, not a new user instruction] " +
              JSON.stringify({ call_id: part.callId }),
          ),
        );
        for (const item of part.content) {
          if (
            !(item instanceof vscode.LanguageModelTextPart) &&
            !(item instanceof vscode.LanguageModelDataPart)
          ) {
            throw new Error("Unsupported historical tool output part");
          }
          content.push(item);
        }
        content.push(
          new vscode.LanguageModelTextPart("[End historical tool output]"),
        );
      } else {
        content.push(part);
      }
    }
    return { ...message, content };
  });
}

/** Only ordinary Responses requests explicitly opted into recovery use this path. */
export async function* streamResponsesWithHistoryRecovery(
  client: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  requestOptions: vscode.LanguageModelChatRequestOptions,
  lifecycle: LanguageModelRequestLifecycle,
  enabled: boolean,
): AsyncGenerator<unknown> {
  if (!enabled || client.vendor !== "copilot") {
    const response = await lifecycle.waitFor(
      client.sendRequest(messages, requestOptions, lifecycle.token),
    );
    yield* interruptibleLanguageModelStream(response.stream, lifecycle);
    return;
  }
  let emitted = false;
  // Register the lifecycle rejection handler before invoking a provider that
  // could synchronously cancel the token and return a rejected promise.
  const send = (history: vscode.LanguageModelChatMessage[]) =>
    lifecycle.waitFor(
      Promise.resolve().then(() => {
        if (lifecycle.token.isCancellationRequested) {
          throw new LanguageModelClientDisconnectedError();
        }
        return client.sendRequest(history, requestOptions, lifecycle.token);
      }),
    );
  try {
    if (lifecycle.token.isCancellationRequested) {
      throw new LanguageModelClientDisconnectedError();
    }
    const response = await send(messages);
    for await (const part of interruptibleLanguageModelStream(
      response.stream,
      lifecycle,
    )) {
      // Even metadata or an unknown future part counts as output. Never replay
      // after a partially observed response, including a generated tool call.
      emitted = true;
      yield part;
    }
    return;
  } catch (error) {
    if (
      !enabled ||
      client.vendor !== "copilot" ||
      emitted ||
      lifecycle.token.isCancellationRequested ||
      !isPairedFailure(error, messages)
    ) {
      throw error;
    }
  }

  logger.warn(
    "Responses experimental history recovery: retrying once with completed tool history represented as labelled text/data context. Request semantics change; recovery is not guaranteed.",
  );
  if (lifecycle.token.isCancellationRequested) {
    throw new LanguageModelClientDisconnectedError();
  }
  const response = await send(historyAsContext(messages));
  yield* interruptibleLanguageModelStream(response.stream, lifecycle);
}
