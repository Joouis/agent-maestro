import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import { extractCopilotUsagePayload } from "./copilotUsage";
import { mimeForVscodeLm } from "./imageMime";
import { type ToolHistoryPart, toolHistoryToVSCode } from "./toolResultPairing";

const textBlockParamToVSCodePart = (param: Anthropic.Messages.TextBlockParam) =>
  new vscode.LanguageModelTextPart(param.text);

const imageBlockParamToVSCodePart = (
  param: Anthropic.Messages.ImageBlockParam,
  options: { preserveMimeType?: boolean } = {},
) => {
  if (param.source.type === "url") {
    return new vscode.LanguageModelTextPart(JSON.stringify(param));
  }

  const bytes = Buffer.from(param.source.data, "base64");
  return new vscode.LanguageModelDataPart(
    bytes,
    options.preserveMimeType
      ? param.source.media_type
      : mimeForVscodeLm(bytes, param.source.media_type),
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
  return new vscode.LanguageModelToolResultPart(
    param.tool_use_id,
    toolResultBlockParamToVSCodeContent(param),
  );
};

const toolResultBlockParamToVSCodeContent = (
  param: Anthropic.Messages.ToolResultBlockParam,
): Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> =>
  !param.content
    ? []
    : typeof param.content === "string"
      ? [new vscode.LanguageModelTextPart(param.content)]
      : param.content.map((content) =>
          content.type === "text"
            ? textBlockParamToVSCodePart(content)
            : content.type === "image"
              ? imageBlockParamToVSCodePart(content, {
                  preserveMimeType: true,
                })
              : new vscode.LanguageModelTextPart(JSON.stringify(content)),
        );

const webSearchToolResultBlockParamToVSCodePart = (
  param: Anthropic.Messages.WebSearchToolResultBlockParam,
) => new vscode.LanguageModelTextPart(JSON.stringify(param));

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
        parts.push(new vscode.LanguageModelTextPart(JSON.stringify(block)));
        break;
      case "web_search_tool_result":
        parts.push(webSearchToolResultBlockParamToVSCodePart(block));
        break;
      default:
        // Handle any other block types as text
        parts.push(new vscode.LanguageModelTextPart(JSON.stringify(block)));
    }
  }

  if (parts.length > 0) {
    return parts;
  }
  return [new vscode.LanguageModelTextPart("")];
};

const createVSCodeMessage = (
  role: Anthropic.Messages.MessageParam["role"],
  contentParts: ReturnType<typeof convertContentToVSCodeParts>,
): vscode.LanguageModelChatMessage =>
  role === "user"
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

/**
 * Convert a single Anthropic MessageParam to a VS Code LanguageModelChatMessage
 *
 * @param message - Anthropic MessageParam with role and content
 * @returns VS Code LanguageModelChatMessage
 */
export const convertAnthropicMessageToVSCode = (
  message: Anthropic.Messages.MessageParam,
): vscode.LanguageModelChatMessage => {
  // Handle string content - always returns single message
  if (typeof message.content === "string") {
    return message.role === "user"
      ? vscode.LanguageModelChatMessage.User(message.content)
      : vscode.LanguageModelChatMessage.Assistant(message.content);
  }

  // Handle array content
  const contentParts = convertContentToVSCodeParts(message.content);

  return createVSCodeMessage(message.role, contentParts);
};

/**
 * Convert an array of Anthropic MessageParams to VS Code LanguageModelChatMessages
 *
 * @param messages - Array of Anthropic MessageParam
 * @returns Array of VS Code LanguageModelChatMessage
 */
export const convertAnthropicMessagesToVSCode = (
  messages: Array<Anthropic.Messages.MessageParam>,
): vscode.LanguageModelChatMessage[] => {
  return toolHistoryToVSCode(
    messages.map((message) => ({
      role: message.role,
      parts:
        typeof message.content === "string"
          ? [
              {
                kind: "content",
                parts: [new vscode.LanguageModelTextPart(message.content)],
              },
            ]
          : message.content.map((block): ToolHistoryPart => {
              if (block.type === "tool_use" && message.role === "assistant") {
                return {
                  kind: "call",
                  id: block.id,
                  name: block.name,
                  toolType: "function",
                  input: block.input as object,
                  value: block.input,
                };
              }
              if (block.type === "tool_result" && message.role === "user") {
                return {
                  kind: "result",
                  id: block.tool_use_id,
                  toolType: "function",
                  parts: toolResultBlockParamToVSCodeContent(block),
                  value: {
                    content: block.content,
                    isError: block.is_error ?? false,
                  },
                  isError: block.is_error,
                };
              }
              if (block.type === "tool_use" || block.type === "tool_result") {
                // A misplaced block is historical context, never a pairing candidate.
                const reference = JSON.stringify(
                  block.type === "tool_use"
                    ? { name: block.name, id: block.id }
                    : { id: block.tool_use_id },
                ).slice(0, 200);
                return {
                  kind: "content",
                  parts:
                    block.type === "tool_use"
                      ? [
                          new vscode.LanguageModelTextPart(
                            `[Tool call in user message: ${reference}. Arguments omitted. Execution status is unknown; verify before retrying.]`,
                          ),
                        ]
                      : [
                          new vscode.LanguageModelTextPart(
                            `[Tool result in assistant message: ${reference}; pairing is uncertain.]`,
                          ),
                          ...(block.is_error
                            ? [
                                new vscode.LanguageModelTextPart(
                                  "[Tool reported an error]",
                                ),
                              ]
                            : []),
                          ...toolResultBlockParamToVSCodeContent(block),
                        ],
                };
              }
              return {
                kind: "content",
                parts: convertContentToVSCodeParts([block]).filter(
                  (
                    part,
                  ): part is
                    | vscode.LanguageModelTextPart
                    | vscode.LanguageModelDataPart =>
                    part instanceof vscode.LanguageModelTextPart ||
                    part instanceof vscode.LanguageModelDataPart,
                ),
              };
            }),
    })),
    "Anthropic",
  );
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
