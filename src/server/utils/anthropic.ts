import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

/**
 * Extract text content from a single Anthropic content block
 */
function extractTextFromContentBlock(
  block: Anthropic.Messages.ContentBlockParam,
): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return block.thinking;
    case "redacted_thinking":
      return block.data;
    case "image":
      return JSON.stringify(block);
    case "document":
      return ""; // Ignore document blocks as specified
    case "tool_use":
    case "tool_result":
    case "server_tool_use":
    case "web_search_tool_result":
      return JSON.stringify(block);
    default:
      // Handle any future block types
      return JSON.stringify(block);
  }
}

/**
 * Check if content array contains media blocks (image or document)
 */
function hasMediaBlocks(
  content: Array<Anthropic.Messages.ContentBlockParam>,
): boolean {
  return content.some(
    (block) => block.type === "image" || block.type === "document",
  );
}

/**
 * Convert Anthropic MessageParam content to text string
 */
function convertContentToText(
  content: string | Array<Anthropic.Messages.ContentBlockParam>,
): string {
  if (typeof content === "string") {
    return content;
  }

  const textParts = content
    .map((block) => extractTextFromContentBlock(block))
    .filter((text) => text.length > 0); // Remove empty strings (e.g., from ignored documents)

  return textParts.join("\n\n");
}

/**
 * Convert a single Anthropic MessageParam to VS Code LanguageModelChatMessage(s)
 *
 * @param message - Anthropic MessageParam with role and content
 * @returns Single message or array of messages based on content type
 */
export function convertAnthropicMessageToVSCode(
  message: Anthropic.Messages.MessageParam,
): vscode.LanguageModelChatMessage | vscode.LanguageModelChatMessage[] {
  // Handle string content - always returns single message
  if (typeof message.content === "string") {
    return message.role === "user"
      ? vscode.LanguageModelChatMessage.User(message.content)
      : vscode.LanguageModelChatMessage.Assistant(message.content);
  }

  // Handle array content
  const hasMedia = hasMediaBlocks(message.content);
  const textContent = convertContentToText(message.content);

  // Create the message
  const vsCodeMessage =
    message.role === "user"
      ? vscode.LanguageModelChatMessage.User(textContent)
      : vscode.LanguageModelChatMessage.Assistant(textContent);

  // Return single message if no media, array if has media
  return hasMedia ? [vsCodeMessage] : vsCodeMessage;
}

/**
 * Convert an array of Anthropic MessageParams to VS Code LanguageModelChatMessages
 * Flattens any array results from individual message conversions
 *
 * @param messages - Array of Anthropic MessageParam
 * @returns Flat array of VS Code LanguageModelChatMessage
 */
export function convertAnthropicMessagesToVSCode(
  messages: Array<Anthropic.Messages.MessageParam>,
): vscode.LanguageModelChatMessage[] {
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
}

/**
 * Convert Anthropic system prompt to VS Code LanguageModelChatMessage array
 * System prompts are treated as Assistant messages in VS Code LM API
 *
 * @param system - Anthropic system prompt (string or array of TextBlockParam)
 * @returns Array of VS Code LanguageModelChatMessage for system content
 */
export function convertAnthropicSystemToVSCode(
  system?: string | Array<Anthropic.Messages.TextBlockParam>,
): vscode.LanguageModelChatMessage[] {
  if (!system) {
    return [];
  }

  if (typeof system === "string") {
    return [vscode.LanguageModelChatMessage.Assistant(system)];
  }

  // Handle array of TextBlockParam
  return system.map((block) =>
    vscode.LanguageModelChatMessage.Assistant(block.text),
  );
}
