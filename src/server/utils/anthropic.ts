import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

const textBlockParamToVSCodePart = (param: Anthropic.Messages.TextBlockParam) =>
  new vscode.LanguageModelTextPart(param.text);

const imageBlockParamToVSCodePart = (
  param: Anthropic.Messages.ImageBlockParam,
) => {
  /**
   * A language model response part containing arbitrary data, not an official API yet.
   */
  const LanguageModelDataPart = (vscode as any).LanguageModelDataPart;

  if (param.source.type === "url" || !LanguageModelDataPart) {
    return new vscode.LanguageModelTextPart(JSON.stringify(param));
  }

  return new LanguageModelDataPart(
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
> => {
  if (typeof content === "string") {
    return [new vscode.LanguageModelTextPart(content)];
  }

  const parts: Array<
    | vscode.LanguageModelTextPart
    | vscode.LanguageModelToolResultPart
    | vscode.LanguageModelToolCallPart
  > = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        parts.push(textBlockParamToVSCodePart(block));
        break;
      case "image":
        // Images are represented as text in VSCode LM API
        parts.push(
          imageBlockParamToVSCodePart(
            block,
          ) as unknown as vscode.LanguageModelTextPart,
        );
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
            vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart
          >,
        )
      : vscode.LanguageModelChatMessage.Assistant(
          contentParts as Array<
            vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
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

export const convertAnthropicToolToVSCode = (
  tools?: Anthropic.Messages.ToolUnion[],
): vscode.LanguageModelChatTool[] | undefined =>
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

/**
 * Token Calibration Coefficients
 * Linear regression model: ŷ = slope * token_count_by_VSCode_API + baseOffset
 */
interface CalibrationCoefficients {
  slope: number;
  baseOffset: number; // Integer baseline adjustment for token count accuracy
}

interface TokenCalibrationConfig {
  input: {
    small: CalibrationCoefficients; // < 10K tokens
    medium: CalibrationCoefficients; // 10K - 50K tokens
    large: CalibrationCoefficients; // 50K - 100K tokens
    xlarge: CalibrationCoefficients; // >= 100K tokens
  };
  output: {
    small: CalibrationCoefficients; // < 10K tokens
    medium: CalibrationCoefficients; // 10K - 50K tokens
    large: CalibrationCoefficients; // 50K - 100K tokens
    xlarge: CalibrationCoefficients; // >= 100K tokens
  };
}

/**
 * Calibration parameters to correct VSCode API token counts to fit actual API usage.
 *
 * Uses linear regression coefficients optimized for different token size ranges.
 * Output tokens use uniform parameters across all ranges due to high variability.
 */
const calibrationConfig: {
  default: TokenCalibrationConfig;
  opus: TokenCalibrationConfig;
} = {
  default: {
    input: {
      small: { slope: 1.065, baseOffset: -120 },
      medium: { slope: 1.082, baseOffset: 1300 },
      large: { slope: 1.05, baseOffset: 2000 },
      xlarge: { slope: 1.05, baseOffset: 1500 },
    },
    output: {
      // Use same parameters for all output token ranges due to insufficient data
      small: { slope: 0.67, baseOffset: 170 },
      medium: { slope: 0.67, baseOffset: 170 },
      large: { slope: 0.67, baseOffset: 170 },
      xlarge: { slope: 0.67, baseOffset: 170 },
    },
  },
  opus: {
    input: {
      small: { slope: 1.1, baseOffset: 0 },
      medium: { slope: 1.1, baseOffset: 1500 },
      large: { slope: 1.12, baseOffset: 1500 },
      xlarge: { slope: 1.14, baseOffset: 1500 },
    },
    output: {
      small: { slope: 1, baseOffset: 150 },
      medium: { slope: 1, baseOffset: 150 },
      large: { slope: 1, baseOffset: 150 },
      xlarge: { slope: 1, baseOffset: 150 },
    },
  },
};

export interface TokenCounts {
  original: number; // Original VSCode API token count
  calibrated: number; // Calibrated token count matching actual API usage
}

/**
 * Calibrate token count to fit actual API usage
 *
 * @param vscodeTokens - Token count from VSCode API
 * @param isInput - True for input tokens, false for output tokens
 * @param modelId - Model ID to determine which calibration config to use
 * @returns Object containing both original and calibrated token counts
 */
function calibrateTokens(
  vscodeTokens: number,
  isInput: boolean,
  modelId?: string,
): TokenCounts {
  // Select config based on model ID
  const configKey = modelId?.toLowerCase().includes("opus")
    ? "opus"
    : "default";
  const config = calibrationConfig[configKey];

  const coefficients = isInput ? config.input : config.output;

  let calibration: CalibrationCoefficients;

  // Select calibration parameters based on token size
  // Thresholds (9K, 45K, 90K) approximate actual API thresholds (10K, 50K, 100K)
  if (vscodeTokens < 9000) {
    calibration = coefficients.small;
  } else if (vscodeTokens < 45000) {
    calibration = coefficients.medium;
  } else if (vscodeTokens < 90000) {
    calibration = coefficients.large;
  } else {
    calibration = coefficients.xlarge;
  }

  // Apply calibration: calibrated = slope × vscode + baseOffset
  const calibrated = calibration.slope * vscodeTokens + calibration.baseOffset;

  return {
    original: vscodeTokens,
    calibrated: Math.round(calibrated),
  };
}

/**
 * Counts the estimated number of tokens in a message for Anthropic models.
 *
 * Note: The underlying countTokens implementation reuses OpenAI's tiktoken tokenizers
 * (O200K), which may not perfectly match Anthropic's actual tokenization.
 *
 * @param message - The message text to count tokens for
 * @param client - The VSCode language model chat client
 * @param isInput - True for input tokens, false for output tokens
 * @param modelId - Model ID to determine which calibration config to use
 * @returns Object containing both original and calibrated token counts
 */
export const countAnthropicMessageTokens = async (
  message: string,
  client: vscode.LanguageModelChat,
  isInput: boolean = true,
  modelId?: string,
): Promise<TokenCounts> => {
  const cancellationToken = new vscode.CancellationTokenSource().token;
  const tokenCount = await client.countTokens(message, cancellationToken);

  return calibrateTokens(tokenCount, isInput, modelId);
};

/**
 * Remove orphaned tool_result and web_search_tool_result blocks from the messages array.
 *
 * The Anthropic API requires every tool_result to reference a tool_use in the
 * immediately preceding assistant message. When conversation history is compacted
 * (e.g. by Claude Code's /compact command), assistant messages containing tool_use
 * blocks may be removed while leaving corresponding tool_result blocks orphaned.
 *
 * This function:
 * 1. Collects tool_use IDs from each assistant message
 * 2. Filters out tool_result blocks in subsequent user messages that don't match
 * 3. Drops user messages that become empty after filtering
 * 4. Merges consecutive same-role messages to maintain user/assistant alternation
 */
export const sanitizeOrphanedToolResults = (
  messages: Array<Anthropic.Messages.MessageParam>,
): Array<Anthropic.Messages.MessageParam> => {
  if (messages.length === 0) {
    return messages;
  }

  const filtered: Array<Anthropic.Messages.MessageParam> = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // Assistant messages pass through unchanged
    if (message.role === "assistant") {
      filtered.push(message);
      continue;
    }

    // User messages with string content pass through unchanged
    if (typeof message.content === "string") {
      filtered.push(message);
      continue;
    }

    // For user messages with array content, check for tool_result blocks
    const hasToolResults = message.content.some(
      (block) =>
        block.type === "tool_result" || block.type === "web_search_tool_result",
    );

    if (!hasToolResults) {
      filtered.push(message);
      continue;
    }

    // Collect tool_use IDs from the immediately preceding assistant message
    const precedingMessage = filtered.at(-1);
    const validToolUseIds = new Set<string>();

    if (
      precedingMessage &&
      precedingMessage.role === "assistant" &&
      typeof precedingMessage.content !== "string"
    ) {
      for (const block of precedingMessage.content) {
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          validToolUseIds.add(block.id);
        }
      }
    }

    // Filter out orphaned tool_result blocks
    const filteredContent = message.content.filter((block) => {
      if (
        block.type === "tool_result" ||
        block.type === "web_search_tool_result"
      ) {
        if (!validToolUseIds.has(block.tool_use_id)) {
          logger.warn(
            `Removing orphaned ${block.type} block with tool_use_id: ${block.tool_use_id}`,
          );
          return false;
        }
      }
      return true;
    });

    // Skip messages that became empty after filtering
    if (filteredContent.length === 0) {
      logger.warn(
        "Dropping empty user message after removing orphaned tool_result blocks",
      );
      continue;
    }

    filtered.push({ ...message, content: filteredContent });
  }

  // Merge consecutive same-role messages to maintain user/assistant alternation
  const merged: Array<Anthropic.Messages.MessageParam> = [];
  for (const message of filtered) {
    const last = merged.at(-1);
    if (last && last.role === message.role) {
      // Merge content into the previous message of the same role
      const lastContent =
        typeof last.content === "string"
          ? [{ type: "text" as const, text: last.content }]
          : last.content;
      const currentContent =
        typeof message.content === "string"
          ? [{ type: "text" as const, text: message.content }]
          : message.content;
      merged[merged.length - 1] = {
        role: message.role,
        content: [...lastContent, ...currentContent],
      };
    } else {
      merged.push(message);
    }
  }

  return merged;
};
