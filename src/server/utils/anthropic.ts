import Anthropic from "@anthropic-ai/sdk";
import {
  LanguageModelChatMessage,
  LanguageModelChatTool,
  LanguageModelChatToolMode,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from "vscode";

const textBlockParamToVSCodePart = (param: Anthropic.Messages.TextBlockParam) =>
  new LanguageModelTextPart(param.text);

const imageBlockParamToVSCodePart = (
  param: Anthropic.Messages.ImageBlockParam,
) => new LanguageModelTextPart(JSON.stringify(param));

const thinkingBlockParamToVSCodePart = (
  param: Anthropic.Messages.ThinkingBlockParam,
) => new LanguageModelTextPart(param.thinking);

const redactedThinkingBlockParamToVSCodePart = (
  param: Anthropic.Messages.RedactedThinkingBlockParam,
) => new LanguageModelTextPart(param.data);

const toolUseBlockParamToVSCodePart = (
  param: Anthropic.Messages.ToolUseBlockParam,
) => new LanguageModelToolCallPart(param.id, param.name, param.input as object);

const toolResultBlockParamToVSCodePart = (
  param: Anthropic.Messages.ToolResultBlockParam,
) => {
  if (!param.content) {
    // If the tool result has no content, return an empty array of parts to indicate no output was produced.
    return new LanguageModelToolResultPart(param.tool_use_id, []);
  }

  const content =
    typeof param.content === "string"
      ? [new LanguageModelTextPart(param.content)]
      : param.content.map((c) =>
          c.type === "text"
            ? textBlockParamToVSCodePart(c)
            : new LanguageModelTextPart(JSON.stringify(c)),
        );
  return new LanguageModelToolResultPart(param.tool_use_id, content);
};

const serverToolUseBlockParamToVSCodePart = (
  param: Anthropic.Messages.ServerToolUseBlockParam,
) => {
  return new LanguageModelToolCallPart(
    param.id,
    param.name,
    param.input as object,
  );
};

const webSearchToolResultBlockParamToVSCodePart = (
  param: Anthropic.Messages.WebSearchToolResultBlockParam,
) => {
  const content = Array.isArray(param.content)
    ? param.content.map((c) => new LanguageModelTextPart(JSON.stringify(c)))
    : [new LanguageModelTextPart(JSON.stringify(param.content))];
  return new LanguageModelToolResultPart(param.tool_use_id, content);
};

/**
 * Convert Anthropic MessageParam content to VSCode LanguageModel content parts
 */
const convertContentToVSCodeParts = (
  content: string | Array<Anthropic.Messages.ContentBlockParam>,
): Array<
  | LanguageModelTextPart
  | LanguageModelToolResultPart
  | LanguageModelToolCallPart
> => {
  if (typeof content === "string") {
    return [new LanguageModelTextPart(content)];
  }

  const parts: Array<
    | LanguageModelTextPart
    | LanguageModelToolResultPart
    | LanguageModelToolCallPart
  > = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(textBlockParamToVSCodePart(block));
        break;
      case "image":
        // Images are represented as text in VSCode LM API
        parts.push(imageBlockParamToVSCodePart(block));
        break;
      case "document":
        // Skip document blocks as specified in original implementation
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
        parts.push(new LanguageModelTextPart(JSON.stringify(block)));
    }
  }

  return parts.length > 0 ? parts : [new LanguageModelTextPart("")];
};

/**
 * Convert a single Anthropic MessageParam to VS Code LanguageModelChatMessage(s)
 *
 * @param message - Anthropic MessageParam with role and content
 * @returns Single message or array of messages based on content type
 */
export const convertAnthropicMessageToVSCode = (
  message: Anthropic.Messages.MessageParam,
): LanguageModelChatMessage | LanguageModelChatMessage[] => {
  // Handle string content - always returns single message
  if (typeof message.content === "string") {
    return message.role === "user"
      ? LanguageModelChatMessage.User(message.content)
      : LanguageModelChatMessage.Assistant(message.content);
  }

  // Handle array content
  const contentParts = convertContentToVSCodeParts(message.content);

  // Create the message
  const vsCodeMessage =
    message.role === "user"
      ? LanguageModelChatMessage.User(
          contentParts as Array<
            LanguageModelTextPart | LanguageModelToolResultPart
          >,
        )
      : LanguageModelChatMessage.Assistant(
          contentParts as Array<
            LanguageModelTextPart | LanguageModelToolCallPart
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
): LanguageModelChatMessage[] => {
  const results: LanguageModelChatMessage[] = [];

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
 * System prompts are treated as Assistant messages in VS Code LM API
 *
 * @param system - Anthropic system prompt (string or array of TextBlockParam)
 * @returns Array of VS Code LanguageModelChatMessage for system content
 */
export const convertAnthropicSystemToVSCode = (
  system?: string | Array<Anthropic.Messages.TextBlockParam>,
): LanguageModelChatMessage[] => {
  if (!system) {
    return [];
  }

  if (typeof system === "string") {
    return [LanguageModelChatMessage.Assistant(system)];
  }

  // Handle array of TextBlockParam
  return system.map((block) => LanguageModelChatMessage.Assistant(block.text));
};

export const convertAnthropicToolToVSCode = (
  tools?: Anthropic.Messages.ToolUnion[],
): LanguageModelChatTool[] | undefined =>
  tools
    ? tools.map((tool) => {
        if (tool.name === "bash") {
          return {
            name: tool.name,
            description: "ToolBash20250124",
            inputSchema: tool,
          };
        } else if (tool.name === "str_replace_editor") {
          return {
            name: tool.name,
            description: "ToolTextEditor20250124",
            inputSchema: tool,
          };
        } else if (tool.name === "str_replace_based_edit_tool") {
          return {
            name: tool.name,
            description: "TextEditor20250429",
            inputSchema: tool,
          };
        } else if (tool.name === "web_search") {
          // Github Copilot API does not support built-in web search tool
          return {
            name: tool.name,
            description: "WebSearchTool20250305",
            inputSchema: {
              ...tool,
              type: "object",
            },
          };
        }

        const t = tool as Anthropic.Messages.Tool;
        return {
          name: t.name,
          description: t.description || "",
          inputSchema: t.input_schema,
        };
      })
    : undefined;

export const convertAnthropicToolChoiceToVSCode = (
  toolChoice?: Anthropic.Messages.ToolChoice,
): LanguageModelChatToolMode | undefined => {
  if (!toolChoice) {
    return undefined;
  }

  switch (toolChoice.type) {
    case "auto":
      return LanguageModelChatToolMode.Auto;

    case "any":
      return LanguageModelChatToolMode.Required;

    case "tool":
      return LanguageModelChatToolMode.Required;

    case "none":
    default:
      return undefined;
  }
};
