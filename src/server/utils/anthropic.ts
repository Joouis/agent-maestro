import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

const textBlockParamToVSCodePart = (param: Anthropic.Messages.TextBlockParam) =>
  new vscode.LanguageModelTextPart(param.text);

const imageBlockParamToVSCodePart = (
  param: Anthropic.Messages.ImageBlockParam,
) => {
  if (param.source.type === "url") {
    return new vscode.LanguageModelTextPart(JSON.stringify(param));
  }

  return new vscode.LanguageModelDataPart(
    Buffer.from(param.source.data, "base64"),
    param.source.media_type,
  );
};

const thinkingBlockParamToVSCodePart = (
  param: Anthropic.Messages.ThinkingBlockParam,
) => new vscode.LanguageModelTextPart(param.thinking);

const redactedThinkingBlockParamToVSCodePart = (
  param: Anthropic.Messages.RedactedThinkingBlockParam,
) => new vscode.LanguageModelTextPart(param.data);

const toolUseBlockParamToVSCodePart = (
  param: Anthropic.Messages.ToolUseBlockParam,
) =>
  new vscode.LanguageModelToolCallPart(
    param.id,
    param.name,
    param.input as object,
  );

const toolResultBlockParamToVSCodePart = (
  param: Anthropic.Messages.ToolResultBlockParam,
) => {
  if (!param.content) {
    // If the tool result has no content, return an empty array of parts to indicate no output was produced.
    return new vscode.LanguageModelToolResultPart(param.tool_use_id, []);
  }

  const content =
    typeof param.content === "string"
      ? [new vscode.LanguageModelTextPart(param.content)]
      : param.content.map((c) =>
          c.type === "text"
            ? textBlockParamToVSCodePart(c)
            : c.type === "image"
              ? imageBlockParamToVSCodePart(c)
              : new vscode.LanguageModelTextPart(JSON.stringify(c)),
        );
  return new vscode.LanguageModelToolResultPart(param.tool_use_id, content);
};

const serverToolUseBlockParamToVSCodePart = (
  param: Anthropic.Messages.ServerToolUseBlockParam,
) => {
  return new vscode.LanguageModelToolCallPart(
    param.id,
    param.name,
    param.input as object,
  );
};

const webSearchToolResultBlockParamToVSCodePart = (
  param: Anthropic.Messages.WebSearchToolResultBlockParam,
) => {
  const content = Array.isArray(param.content)
    ? param.content.map(
        (c) => new vscode.LanguageModelTextPart(JSON.stringify(c)),
      )
    : [new vscode.LanguageModelTextPart(JSON.stringify(param.content))];
  return new vscode.LanguageModelToolResultPart(param.tool_use_id, content);
};

const searchResultBlockParamToVSCodePart = (
  param: Anthropic.Messages.SearchResultBlockParam,
) => {
  // Format the search result as readable text with title, source, and content
  const contentText = param.content.map((c) => c.text).join("\n");
  const formattedText = `[Search Result: ${param.title}]\nSource: ${param.source}\n\n${contentText}`;
  return new vscode.LanguageModelTextPart(formattedText);
};

/**
 * Convert Anthropic MessageParam content to VSCode LanguageModel content parts
 */
const convertContentToVSCodeParts = (
  content: string | Array<Anthropic.Messages.ContentBlockParam>,
): Array<
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolResultPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelDataPart
> => {
  if (typeof content === "string") {
    return [new vscode.LanguageModelTextPart(content)];
  }

  const parts: Array<
    | vscode.LanguageModelTextPart
    | vscode.LanguageModelToolResultPart
    | vscode.LanguageModelToolCallPart
    | vscode.LanguageModelDataPart
  > = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(textBlockParamToVSCodePart(block));
        break;
      case "image":
        parts.push(imageBlockParamToVSCodePart(block));
        break;
      case "document":
        // Skip document blocks as specified in original implementation
        break;
      case "search_result":
        parts.push(searchResultBlockParamToVSCodePart(block));
        break;
      case "thinking":
        parts.push(thinkingBlockParamToVSCodePart(block));
        break;
      case "redacted_thinking":
        parts.push(redactedThinkingBlockParamToVSCodePart(block));
        break;
      case "tool_use":
        parts.push(toolUseBlockParamToVSCodePart(block));
        break;
      case "tool_result":
        parts.push(toolResultBlockParamToVSCodePart(block));
        break;
      case "server_tool_use":
        parts.push(serverToolUseBlockParamToVSCodePart(block));
        break;
      case "web_search_tool_result":
        parts.push(webSearchToolResultBlockParamToVSCodePart(block));
        break;
      default:
        // Handle any other block types as text
        parts.push(new vscode.LanguageModelTextPart(JSON.stringify(block)));
    }
  }

  return parts.length > 0 ? parts : [new vscode.LanguageModelTextPart("")];
};

/**
 * Convert a single Anthropic MessageParam to VS Code LanguageModelChatMessage(s)
 *
 * @param message - Anthropic MessageParam with role and content
 * @returns Single message or array of messages based on content type
 */
export const convertAnthropicMessageToVSCode = (
  message: Anthropic.Messages.MessageParam,
): vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[] => {
  // Handle string content - always returns single message
  if (typeof message.content === "string") {
    return message.role === "user"
      ? vscode.LanguageModelChatMessage.User(message.content)
      : vscode.LanguageModelChatMessage.Assistant(message.content);
  }

  // Handle array content
  const contentParts = convertContentToVSCodeParts(message.content);

  // Create the message
  const vsCodeMessage =
    message.role === "user"
      ? vscode.LanguageModelChatMessage.User(
          contentParts as Array<
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelToolResultPart
            | vscode.LanguageModelDataPart
          >,
        )
      : vscode.LanguageModelChatMessage.Assistant(
          contentParts as Array<
            | vscode.LanguageModelTextPart
            | vscode.LanguageModelToolCallPart
            | vscode.LanguageModelDataPart
          >,
        );

  return vsCodeMessage;
};

/**
 * Result of validating tool_use ↔ tool_result pairing across a message list.
 * `orphanIds` is the de-duplicated set of `tool_use_id`s referenced by a
 * `tool_result` that has no matching `tool_use` in an earlier message.
 */
export type ToolPairingValidation =
  | { ok: true }
  | { ok: false; orphanIds: string[] };

/**
 * The Anthropic API requires every `tool_result` block to point at a
 * `tool_use` that appeared in an earlier assistant message. When the request
 * we're about to forward violates this, the upstream returns:
 *   "unexpected `tool_use_id` found in `tool_result` blocks: <id>"
 *
 * We validate the same invariant locally before conversion so that:
 *   1. Genuinely malformed client requests are rejected up-front with a 400,
 *      rather than slipping through to vscode.lm and surfacing as a 500.
 *   2. When vscode.lm later reports the same error class, we can be confident
 *      the orphan was introduced downstream (typically Copilot's internal
 *      message truncation) and treat it as a context-window event.
 *
 * Design choices when the rules are ambiguous:
 *   - Only `assistant`-role `tool_use` blocks register ids. A `tool_use` in a
 *     user message is itself protocol-illegal, but we don't treat it as a
 *     "matching" use for a later `tool_result` — that would mask the bug.
 *   - We accept a `tool_use` without a matching `tool_result` (in-flight or
 *     intentionally dropped).
 *   - We tolerate a `tool_use` and its `tool_result` co-located in the same
 *     assistant message (registration happens in a first pass before the
 *     result pass, making the verdict order-independent within one message).
 *     A `tool_result` in a *user* message must still reference a `tool_use`
 *     from an *earlier* assistant message — that is the only protocol-valid
 *     placement, and is the case the wire bug actually breaks.
 *   - All Anthropic SDK *success* result block types that carry a
 *     `tool_use_id` are pooled into one id set against all `tool_use` /
 *     `server_tool_use` blocks. The `*_tool_result_error` SDK variants
 *     (e.g. `web_search_tool_result_error`) are *inner content* of those
 *     success blocks, not top-level message blocks, and do not carry a
 *     `tool_use_id` of their own — so they correctly aren't in this set.
 *     Anthropic technically pairs result types to specific use types, but
 *     we don't distinguish here because doing so adds little protection
 *     and risks false positives. Recognized result types are kept in sync
 *     with `@anthropic-ai/sdk` — extend `RESULT_BLOCK_TYPES` below when
 *     new ones ship.
 *
 * Non-array / null / malformed inputs are treated as ok — schema validation
 * is the route layer's responsibility; this function should never throw.
 */
export const validateAnthropicToolPairing = (
  messages: Array<Anthropic.Messages.MessageParam>,
): ToolPairingValidation => {
  if (!Array.isArray(messages)) {
    return { ok: true };
  }

  // Block types from `@anthropic-ai/sdk` that carry a `tool_use_id` referencing
  // an earlier tool_use. Kept explicit (rather than suffix-matching) so adding
  // a new SDK type is a deliberate, reviewable change.
  const RESULT_BLOCK_TYPES = new Set<string>([
    "tool_result",
    "web_search_tool_result",
    "web_fetch_tool_result",
    "code_execution_tool_result",
    "bash_code_execution_tool_result",
    "text_editor_code_execution_tool_result",
    "tool_search_tool_result",
  ]);
  const USE_BLOCK_TYPES = new Set<string>(["tool_use", "server_tool_use"]);

  const knownToolUseIds = new Set<string>();
  const orphanIds = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const { role, content } = message;
    if (content === null || content === undefined) {
      continue;
    }
    if (typeof content === "string" || !Array.isArray(content)) {
      continue;
    }

    // Two passes per message. The first registers every assistant-role
    // tool_use id from this message so that a tool_result in the SAME
    // message — including one whose block sits before its tool_use in the
    // content array — can find its pair. A single forward pass would make
    // the verdict order-sensitive within one message, which is wrong: the
    // Anthropic protocol orders by message, not by block index inside a
    // message's content. The cost is one extra cheap iteration per message.
    for (const block of content) {
      if (!block || typeof block !== "object" || !("type" in block)) {
        continue;
      }
      if (!USE_BLOCK_TYPES.has(block.type)) {
        continue;
      }
      // Only assistant-role tool_use blocks may register ids. A tool_use
      // in a user message is itself out-of-spec; treating it as "known"
      // would let a follow-up tool_result silently satisfy validation
      // even though the upstream will still reject the conversation.
      if (role !== "assistant") {
        continue;
      }
      const { id } = block as { id?: unknown };
      if (typeof id === "string" && id.length > 0) {
        knownToolUseIds.add(id);
      }
    }

    for (const block of content) {
      if (!block || typeof block !== "object" || !("type" in block)) {
        continue;
      }
      if (!RESULT_BLOCK_TYPES.has(block.type)) {
        continue;
      }
      const { tool_use_id } = block as { tool_use_id?: unknown };
      if (typeof tool_use_id !== "string" || tool_use_id.length === 0) {
        continue;
      }
      if (!knownToolUseIds.has(tool_use_id)) {
        orphanIds.add(tool_use_id);
      }
    }
  }

  if (orphanIds.size === 0) {
    return { ok: true };
  }
  return { ok: false, orphanIds: Array.from(orphanIds) };
};

/**
 * Thrown by `prepareAnthropicMessages` when the incoming request itself
 * contains orphan `tool_result` blocks. Routes should map this to a 400
 * `invalid_request_error` rather than letting it reach vscode.lm.
 */
export class OrphanToolResultError extends Error {
  readonly orphanIds: string[];

  constructor(orphanIds: string[]) {
    super(
      `Request contains tool_result block(s) with no matching tool_use in any earlier assistant message: ${orphanIds.join(", ")}`,
    );
    this.name = "OrphanToolResultError";
    this.orphanIds = orphanIds;
    // Preserve the prototype chain across transpilation boundaries so that
    // `err instanceof OrphanToolResultError` works in all consumers.
    Object.setPrototypeOf(this, OrphanToolResultError.prototype);
  }
}

/**
 * vscode.lm surfaces this exact substring when the message array forwarded
 * to the upstream contains a `tool_result` whose `tool_use_id` doesn't match
 * any prior `tool_use`. Because routes run `validateAnthropicToolPairing`
 * before forwarding, any request that reaches vscode.lm is known to be
 * well-formed at our boundary — so this error string only fires when
 * something between us and the upstream dropped a tool_use but kept its
 * tool_result. There are two known causes (see `isInputAtOrOverCapacity`):
 *
 *   1. Copilot's internal message truncation as it approaches its context
 *      window — a *capacity* problem, recoverable via auto-compact.
 *   2. Some other Copilot-side bug (also reported by litellm users) that
 *      can produce this error even when capacity is well below the limit.
 *
 * This helper only confirms the error *shape*. Routes pair it with
 * `isInputAtOrOverCapacity` to decide whether to translate (case 1) or
 * rethrow (case 2 — let the underlying bug surface so it can be reported
 * upstream).
 */
export const isDownstreamTruncationOrphan = (errorMessage: string): boolean =>
  errorMessage.includes(
    "unexpected `tool_use_id` found in `tool_result` blocks",
  );

/**
 * True when the calibrated input token count is at or over the model's
 * advertised max input capacity. Used together with
 * `isDownstreamTruncationOrphan` to disambiguate which of the two known
 * causes produced an orphan error: a *capacity-driven* orphan (this returns
 * true) is recoverable via Claude Code auto-compact, so we translate it to
 * `model_context_window_exceeded`; a *capacity-clear* orphan (this returns
 * false) is almost certainly a Copilot-side bug, and the right move is to
 * let it propagate so the upstream bug stays visible.
 *
 * Calibrated tokens are produced by `countAnthropicMessageTokens`, which
 * applies `agent-maestro.anthropic.tokenCountScaleFactor` (default 1.25) on
 * top of vscode.lm's count. That scale factor is *also* the safety margin
 * here: a calibrated value at the cap means the raw vscode.lm count is at
 * 1 / 1.25 ≈ 80% of the cap — already in the band where Copilot's internal
 * truncation kicks in. Users can tune the scale factor to widen or narrow
 * this band; we deliberately don't introduce a separate threshold knob.
 *
 * Returns false for non-positive `maxInputTokens` (the model didn't
 * advertise a cap, so we can't reason about capacity at all).
 */
export const isInputAtOrOverCapacity = (
  inputTokensCalibrated: number,
  maxInputTokens: number,
): boolean => {
  if (!Number.isFinite(maxInputTokens) || maxInputTokens <= 0) {
    return false;
  }
  return inputTokensCalibrated >= maxInputTokens;
};

/**
 * Convert an array of Anthropic MessageParams to VS Code LanguageModelChatMessages
 * Flattens any array results from individual message conversions
 *
 * @param messages - Array of Anthropic MessageParam
 * @returns Flat array of VS Code LanguageModelChatMessage
 */
export const convertAnthropicMessagesToVSCode = (
  messages: Array<Anthropic.Messages.MessageParam>,
): vscode.LanguageModelChatMessage[] => {
  const results: vscode.LanguageModelChatMessage[] = [];

  for (const message of messages) {
    const converted = convertAnthropicMessageToVSCode(message);
    if (Array.isArray(converted)) {
      results.push(...converted);
    } else {
      results.push(converted);
    }
  }

  return results;
};

/**
 * Convert Anthropic system prompt to VS Code LanguageModelChatMessage array
 * System prompts are treated as User messages in VS Code LM API
 *
 * @param system - Anthropic system prompt (string or array of TextBlockParam)
 * @returns Array of VS Code LanguageModelChatMessage for system content
 */
export const convertAnthropicSystemToVSCode = (
  system?: string | Array<Anthropic.Messages.TextBlockParam>,
): vscode.LanguageModelChatMessage[] => {
  if (!system) {
    return [];
  }

  if (typeof system === "string") {
    return [vscode.LanguageModelChatMessage.User(system)];
  }

  // Handle array of TextBlockParam
  return system.map((block) =>
    vscode.LanguageModelChatMessage.User(block.text),
  );
};

/**
 * Anthropic server-side tools (web_search, code_execution, computer_use,
 * bash, text_editor, memory, web_fetch, etc.) are executed by Anthropic's
 * backend, not the client. They are identified by the presence of a `type`
 * field other than `"custom"` and the absence of `input_schema`.
 *
 * VS Code's Language Model API has no way to execute them — forwarding them
 * causes the upstream to reject the request (`tools.0.custom.input_schema.type:
 * Input should be 'object'`) or silently hang waiting for a tool result that
 * never comes. We drop them here so the model is not told they exist.
 */
const isUnsupportedServerSideTool = (tool: unknown): boolean => {
  const t = tool as { type?: string; input_schema?: unknown };
  return typeof t.type === "string" && t.type !== "custom" && !t.input_schema;
};

export const convertAnthropicToolToVSCode = (
  tools?: Anthropic.Messages.ToolUnion[],
): vscode.LanguageModelChatTool[] | undefined => {
  if (!tools) {
    return undefined;
  }

  const filtered: vscode.LanguageModelChatTool[] = [];
  for (const tool of tools) {
    if (isUnsupportedServerSideTool(tool)) {
      logger.warn(
        `Dropping unsupported Anthropic server-side tool: ${
          (tool as { type?: string }).type
        } — VS Code Language Model API cannot execute it`,
      );
      continue;
    }
    const t = tool as Anthropic.Messages.Tool;
    filtered.push({
      name: t.name,
      description: t.description || "",
      inputSchema: t.input_schema,
    });
  }
  return filtered;
};

export const convertAnthropicToolChoiceToVSCode = (
  toolChoice?: Anthropic.Messages.ToolChoice,
): vscode.LanguageModelChatToolMode | undefined => {
  if (!toolChoice) {
    return undefined;
  }

  switch (toolChoice.type) {
    case "auto":
      return vscode.LanguageModelChatToolMode.Auto;

    case "any":
      return vscode.LanguageModelChatToolMode.Required;

    case "tool":
      return vscode.LanguageModelChatToolMode.Required;

    case "none":
    default:
      return undefined;
  }
};

const DEFAULT_TOKEN_SCALE_FACTOR = 1.25;

export interface TokenCounts {
  original: number; // Original VSCode API token count
  calibrated: number; // Scaled token count approximating actual API usage
}

interface CopilotUsagePayload {
  completion_tokens: number;
  prompt_tokens: number;
  prompt_tokens_details?: {
    cache_creation_input_tokens?: number;
    cached_tokens?: number;
  };
}

export interface AnthropicTokenUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

function isCopilotUsagePayload(value: unknown): value is CopilotUsagePayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const usage = value as Partial<CopilotUsagePayload>;
  return (
    typeof usage.prompt_tokens === "number" &&
    Number.isFinite(usage.prompt_tokens) &&
    usage.prompt_tokens >= 0 &&
    typeof usage.completion_tokens === "number" &&
    Number.isFinite(usage.completion_tokens) &&
    usage.completion_tokens >= 0
  );
}

const clampNonNegative = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Decodes Copilot usage metadata from a VS Code LM `LanguageModelDataPart`.
 * Caller is responsible for verifying the chunk is a data part.
 */
export function extractAnthropicTokenUsageFromVSCodeChunk(chunk: {
  data: Uint8Array;
  mimeType: string;
}): AnthropicTokenUsage | undefined {
  if (chunk.mimeType !== "usage") {
    return undefined;
  }

  try {
    const usage = JSON.parse(new TextDecoder().decode(chunk.data)) as unknown;
    if (!isCopilotUsagePayload(usage)) {
      return undefined;
    }

    const cacheCreationInputTokens = clampNonNegative(
      usage.prompt_tokens_details?.cache_creation_input_tokens,
    );
    const cacheReadInputTokens = clampNonNegative(
      usage.prompt_tokens_details?.cached_tokens,
    );

    return {
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
      input_tokens: Math.max(
        0,
        usage.prompt_tokens - cacheCreationInputTokens - cacheReadInputTokens,
      ),
      output_tokens: usage.completion_tokens,
    };
  } catch {
    return undefined;
  }
}

/**
 * Counts the estimated number of tokens in a message for Anthropic models.
 *
 * Applies a configurable scale factor to compensate for the difference between
 * VS Code's tiktoken-based counting and Anthropic's actual tokenization.
 * The scale factor can be adjusted via the `agent-maestro.anthropic.tokenCountScaleFactor` setting.
 *
 * @param message - The message text to count tokens for
 * @param client - The VSCode language model chat client
 * @returns Object containing both original and scaled token counts
 */
export const countAnthropicMessageTokens = async (
  message: string,
  client: vscode.LanguageModelChat,
): Promise<TokenCounts> => {
  const scaleFactor = vscode.workspace
    .getConfiguration("agent-maestro.anthropic")
    .get<number>("tokenCountScaleFactor", DEFAULT_TOKEN_SCALE_FACTOR);

  const cancellationToken = new vscode.CancellationTokenSource().token;
  const tokenCount = await client.countTokens(message, cancellationToken);

  return {
    original: tokenCount,
    calibrated: Math.round(tokenCount * scaleFactor),
  };
};
