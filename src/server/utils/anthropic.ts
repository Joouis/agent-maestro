import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import { extractCopilotUsagePayload } from "./copilotUsage";

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
 * Append an extra system note to an Anthropic `system` field, normalizing
 * whichever shape the caller used (undefined / string / TextBlockParam[]).
 * Used to inject the `web_search` → WebFetch fallback nudge without
 * polluting the conversation transcript with a synthetic user turn.
 */
export const appendSystemNote = (
  system: string | Array<Anthropic.Messages.TextBlockParam> | undefined,
  note: string,
): Array<Anthropic.Messages.TextBlockParam> => {
  const noteBlock: Anthropic.Messages.TextBlockParam = {
    type: "text",
    text: note,
  };
  if (!system) {
    return [noteBlock];
  }
  if (typeof system === "string") {
    return [{ type: "text", text: system }, noteBlock];
  }
  return [...system, noteBlock];
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

/**
 * Detect Anthropic web_search server-side tool variants
 * (e.g. `web_search_20250305`).
 */
const isWebSearchServerSideTool = (tool: unknown): boolean => {
  const t = tool as { type?: string };
  return typeof t.type === "string" && t.type.startsWith("web_search");
};

/**
 * System-prompt nudge appended when a client requested `web_search` but the
 * backend can't execute it. Tells the model to fall back to `WebFetch` (a
 * standard Claude Code client-side tool) against a public search-engine URL,
 * so the user still gets web-search-like behavior with zero proxy-side
 * dependencies.
 */
export const WEB_SEARCH_FALLBACK_SYSTEM_NOTE =
  "The Anthropic `web_search` server-side tool is unavailable on this proxy. " +
  "To search the web, use the `WebFetch` tool with a URL like " +
  "`https://html.duckduckgo.com/html/?q=<URL-encoded query>` and a prompt " +
  "asking it to extract the most relevant result titles, URLs, and snippets. " +
  "If WebFetch is unavailable or cannot access the search page, tell the " +
  "user the search URL so they can open it manually.";

export interface ConvertAnthropicToolResult {
  tools: vscode.LanguageModelChatTool[] | undefined;
  webSearchDropped: boolean;
}

export const convertAnthropicToolToVSCode = (
  tools?: Anthropic.Messages.ToolUnion[],
): ConvertAnthropicToolResult => {
  if (!tools) {
    return { tools: undefined, webSearchDropped: false };
  }

  const filtered: vscode.LanguageModelChatTool[] = [];
  let webSearchDropped = false;
  for (const tool of tools) {
    if (isUnsupportedServerSideTool(tool)) {
      if (isWebSearchServerSideTool(tool)) {
        webSearchDropped = true;
      }
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
  return { tools: filtered, webSearchDropped };
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

export interface AnthropicTokenUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

const clampNonNegative = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Decodes Copilot usage metadata from a VS Code LM `LanguageModelDataPart`.
 * Caller is responsible for verifying the chunk is a data part.
 */
export function extractAnthropicUsage(chunk: {
  data: Uint8Array;
  mimeType: string;
}): AnthropicTokenUsage | undefined {
  const usage = extractCopilotUsagePayload(chunk);
  if (!usage) {
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

  const cancellationTokenSource = new vscode.CancellationTokenSource();
  try {
    const tokenCount = await client.countTokens(
      message,
      cancellationTokenSource.token,
    );

    return {
      original: tokenCount,
      calibrated: Math.round(tokenCount * scaleFactor),
    };
  } finally {
    cancellationTokenSource.dispose();
  }
};
