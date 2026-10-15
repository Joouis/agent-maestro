import * as vscode from "vscode";

import { logger } from "../../utils/logger";

// Some released hosts expose these runtime objects without stable typings.
// Keep the optional contract local; do not enable or augment a proposed API.
export interface ThinkingPart {
  value: string | string[];
  id?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export function hasEncryptedThinking(
  part: ThinkingPart,
): part is ThinkingPart & {
  id: string;
  metadata: Readonly<Record<string, unknown>> & { encrypted_content: string };
} {
  return (
    part.metadata?.vscode_thinking_origin_api === "responses" &&
    typeof part.id === "string" &&
    part.id.length > 0 &&
    typeof part.metadata.encrypted_content === "string" &&
    part.metadata.encrypted_content.length > 0
  );
}

interface ThinkingConstructor {
  new (
    value: string | string[],
    id?: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): ThinkingPart;
}

export type ModelInputPart = vscode.LanguageModelInputPart | ThinkingPart;

interface RuntimeMessage {
  role: vscode.LanguageModelChatMessageRole;
  content: ModelInputPart[];
  name?: string;
}

export interface ThinkingRuntime {
  Thinking: ThinkingConstructor;
  Message: new (
    role: vscode.LanguageModelChatMessageRole,
    content: ModelInputPart[],
  ) => RuntimeMessage;
}

export function detectThinkingRuntime(
  api: object,
): ThinkingRuntime | undefined {
  try {
    const Thinking: unknown = Reflect.get(api, "LanguageModelThinkingPart");
    const Message: unknown = Reflect.get(api, "LanguageModelChatMessage2");
    if (typeof Thinking === "function" && typeof Message === "function") {
      return {
        Thinking: Thinking as ThinkingConstructor,
        Message: Message as ThinkingRuntime["Message"],
      };
    }
  } catch {
    logger.warn(
      "Responses reasoning unavailable: host capability access failed",
    );
    return undefined;
  }
  logger.debug("Responses reasoning unavailable: host constructors missing");
  return undefined;
}

let runtime: ThinkingRuntime | undefined;
let detected = false;
export function getThinkingRuntime(): ThinkingRuntime | undefined {
  if (!detected) {
    runtime = detectThinkingRuntime(vscode);
    detected = true;
  }
  return runtime;
}

export const isThinkingPart = (part: unknown): part is ThinkingPart => {
  const runtime = getThinkingRuntime();
  return runtime !== undefined && part instanceof runtime.Thinking;
};

export function createModelMessage(
  role: vscode.LanguageModelChatMessageRole,
  parts: ModelInputPart[],
): vscode.LanguageModelChatMessage {
  if (parts.some(isThinkingPart)) {
    const runtime = getThinkingRuntime()!;
    // The single boundary cast bridges the stable message signature to the
    // detected host constructor. Plain objects are never used as thinking.
    return new runtime.Message(role, parts) as vscode.LanguageModelChatMessage;
  }
  return new vscode.LanguageModelChatMessage(
    role,
    parts as vscode.LanguageModelInputPart[],
  );
}

export const encryptedThinkingOptions =
  (): vscode.LanguageModelChatRequestOptions & {
    includeEncryptedThinking?: boolean;
  } => (getThinkingRuntime() ? { includeEncryptedThinking: true } : {});
