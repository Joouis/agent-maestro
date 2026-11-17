import * as vscode from "vscode";

import {
  type CopilotModelConfiguration,
  chatModelsCache,
  getChatModelClient,
  isStaleModelHandleError,
  withCopilotConfiguration,
} from "../../utils/chatModels";
import { logger } from "../../utils/logger";
import type { LanguageModelRequestLifecycle } from "./languageModelRequestLifecycle";

type ResolveChatModelClient = (
  modelId: string,
) => Promise<{ client?: vscode.LanguageModelChat }>;

export interface SendLanguageModelRequestParams {
  client: vscode.LanguageModelChat;
  messages: vscode.LanguageModelChatMessage[];
  options: vscode.LanguageModelChatRequestOptions;
  /**
   * Applied per attempt with {@link withCopilotConfiguration}, which also sets
   * the model's context size. Pass `false` when `options` are already
   * configured for this model, as in the web-search loops.
   */
  copilotConfiguration?: CopilotModelConfiguration | false;
  /**
   * Interrupts on client disconnect or timeout and supplies the cancellation
   * token. Routes without a lifecycle pass `cancellationToken` instead.
   */
  lifecycle?: LanguageModelRequestLifecycle;
  cancellationToken?: vscode.CancellationToken;
  /** Injected by route tests; defaults to {@link getChatModelClient}. */
  resolve?: ResolveChatModelClient;
}

export interface SentLanguageModelRequest {
  response: vscode.LanguageModelChatResponse;
  /** The handle that served the request; use it for later calls such as `countTokens`. */
  client: vscode.LanguageModelChat;
}

/**
 * Sends a chat request, recovering once from a stale model handle.
 *
 * A handle captures the internal model ID from discovery time. If VS Code
 * re-registered the model since, the request fails before it starts; this
 * re-resolves the same public model ID and retries once. Retrying is safe
 * because no output exists yet. It never switches models, and never retries
 * other errors or a cancelled request.
 */
export async function sendLanguageModelRequest(
  params: SendLanguageModelRequestParams,
): Promise<SentLanguageModelRequest> {
  const { lifecycle } = params;
  if (!lifecycle) {
    return sendWithStaleModelRetry(params);
  }
  // The client may disconnect, or the timeout fire, while the model is being
  // resolved. Do not start a request then: waitFor would reject immediately
  // without observing it, leaving its cancellation rejection unhandled.
  if (lifecycle.signal.aborted) {
    throw lifecycle.signal.reason;
  }
  return lifecycle.waitFor(sendWithStaleModelRetry(params));
}

async function sendWithStaleModelRetry({
  client,
  messages,
  options,
  copilotConfiguration = {},
  lifecycle,
  cancellationToken = lifecycle?.token,
  resolve = getChatModelClient,
}: SendLanguageModelRequestParams): Promise<SentLanguageModelRequest> {
  const send = async (
    lmClient: vscode.LanguageModelChat,
  ): Promise<SentLanguageModelRequest> => ({
    response: await lmClient.sendRequest(
      messages,
      copilotConfiguration === false
        ? options
        : withCopilotConfiguration(lmClient, options, copilotConfiguration),
      cancellationToken,
    ),
    client: lmClient,
  });

  try {
    return await send(client);
  } catch (error) {
    if (
      !isStaleModelHandleError(error) ||
      cancellationToken?.isCancellationRequested
    ) {
      throw error;
    }
    logger.warn(
      `Model handle for "${client.id}" is stale; re-resolving once and retrying`,
    );
    chatModelsCache.invalidate();
    const { client: fresh } = await resolve(client.id);
    // Re-resolution can take a while; do not start a request nobody will read.
    if (
      !fresh ||
      fresh.id !== client.id ||
      fresh === client ||
      cancellationToken?.isCancellationRequested
    ) {
      throw error;
    }
    return await send(fresh);
  }
}
