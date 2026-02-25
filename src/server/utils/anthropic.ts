import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

/**
 * Collect tool_use IDs from an assistant message's content blocks.
 */
function getToolUseIds(
  content: string | Array<Anthropic.Messages.ContentBlockParam>,
): Set<string> {
  const ids = new Set<string>();
  if (typeof content === "string") {
    return ids;
  }
  for (const block of content) {
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      ids.add((block as Anthropic.Messages.ToolUseBlockParam).id);
    }
  }
  return ids;
}

/**
 * Collect tool_result tool_use_ids from a user message's content blocks.
 */
function getToolResultIds(
  content: string | Array<Anthropic.Messages.ContentBlockParam>,
): Set<string> {
  const ids = new Set<string>();
  if (typeof content === "string") {
    return ids;
  }
  for (const block of content) {
    if (
      block.type === "tool_result" ||
      block.type === "web_search_tool_result"
    ) {
      ids.add((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id);
    }
  }
  return ids;
}

/**
 * Repair tool_use / tool_result pairing in Anthropic message arrays.
 *
 * The Anthropic API requires that every tool_result in a user message references
 * a tool_use_id from the immediately preceding assistant message. This function
 * ensures that invariant holds by:
 *
 * 1. Removing orphaned tool_result blocks (no matching tool_use in prev assistant msg)
 *    and converting their content to plain text blocks so the context is preserved.
 * 2. Adding synthetic tool_result blocks for orphaned tool_use blocks (assistant has
 *    tool_use but the next user message has no matching tool_result).
 *
 * This is necessary because the VS Code Language Model API backend may reject
 * messages with broken pairings even though Agent Maestro faithfully forwards them.
 */
export function repairToolUseResultPairing(
  messages: Array<Anthropic.Messages.MessageParam>,
): Array<Anthropic.Messages.MessageParam> {
  const result: Array<Anthropic.Messages.MessageParam> = [];
  let repairCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      // Find the preceding assistant message (if any)
      const prevMsg = result.length > 0 ? result[result.length - 1] : null;

      if (prevMsg && prevMsg.role === "assistant") {
        const assistantToolUseIds = getToolUseIds(prevMsg.content);
        const userToolResultIds = getToolResultIds(msg.content);

        // --- Fix orphaned tool_results ---
        // tool_result blocks whose tool_use_id is NOT in the previous assistant message
        if (typeof msg.content !== "string") {
          const fixedContent: Array<Anthropic.Messages.ContentBlockParam> = [];
          for (const block of msg.content) {
            if (
              (block.type === "tool_result" ||
                block.type === "web_search_tool_result") &&
              !assistantToolUseIds.has(
                (block as Anthropic.Messages.ToolResultBlockParam).tool_use_id,
              )
            ) {
              // Convert orphaned tool_result to text so context is not lost
              const trBlock = block as Anthropic.Messages.ToolResultBlockParam;
              const textContent =
                typeof trBlock.content === "string"
                  ? trBlock.content
                  : Array.isArray(trBlock.content)
                    ? trBlock.content
                        .map((c) =>
                          c.type === "text"
                            ? (c as Anthropic.Messages.TextBlockParam).text
                            : JSON.stringify(c),
                        )
                        .join("\n")
                    : "";
              if (textContent) {
                fixedContent.push({
                  type: "text",
                  text: `[Tool result for ${trBlock.tool_use_id}]: ${textContent}`,
                } as Anthropic.Messages.TextBlockParam);
              }
              logger.debug(
                `repairToolUseResultPairing: converted orphaned tool_result ${trBlock.tool_use_id} to text at message index ${i}`,
              );
              repairCount++;
            } else {
              fixedContent.push(block);
            }
          }

          // Ensure the user message has at least some content
          if (fixedContent.length === 0) {
            fixedContent.push({
              type: "text",
              text: "",
            } as Anthropic.Messages.TextBlockParam);
          }

          result.push({ ...msg, content: fixedContent });
        } else {
          result.push(msg);
        }

        // --- Fix orphaned tool_use blocks ---
        // tool_use blocks in the assistant message with no matching tool_result
        const orphanedToolUseIds = new Set<string>();
        for (const id of assistantToolUseIds) {
          // Check against the (possibly fixed) user message's tool_result ids
          const currentUserResultIds = getToolResultIds(
            result[result.length - 1].content,
          );
          if (!currentUserResultIds.has(id)) {
            orphanedToolUseIds.add(id);
          }
        }

        if (orphanedToolUseIds.size > 0) {
          // Inject synthetic tool_result blocks into the user message
          const userMsg = result[result.length - 1];
          const userContent =
            typeof userMsg.content === "string"
              ? [
                  {
                    type: "text",
                    text: userMsg.content,
                  } as Anthropic.Messages.TextBlockParam,
                ]
              : [...userMsg.content];

          // Add synthetic results BEFORE other content
          const syntheticResults: Array<Anthropic.Messages.ContentBlockParam> =
            [];
          for (const id of orphanedToolUseIds) {
            syntheticResults.push({
              type: "tool_result",
              tool_use_id: id,
              content: "[No output captured]",
            } as Anthropic.Messages.ToolResultBlockParam);
            repairCount++;
          }

          result[result.length - 1] = {
            ...userMsg,
            content: [...syntheticResults, ...userContent],
          };
        }
      } else {
        // No preceding assistant message — just drop any tool_result blocks
        if (typeof msg.content !== "string") {
          const droppedIds: string[] = [];
          const fixedContent = msg.content.filter((block) => {
            if (
              block.type === "tool_result" ||
              block.type === "web_search_tool_result"
            ) {
              droppedIds.push(
                (block as Anthropic.Messages.ToolResultBlockParam).tool_use_id,
              );
              return false;
            }
            return true;
          });
          if (droppedIds.length > 0) {
            logger.warn(
              `repairToolUseResultPairing: dropped ${droppedIds.length} orphaned tool_result(s) at message index ${i} (no preceding assistant): ${droppedIds.join(", ")}`,
            );
            repairCount += droppedIds.length;
          }
          result.push({
            ...msg,
            content:
              fixedContent.length > 0
                ? fixedContent
                : [
                    {
                      type: "text",
                      text: "",
                    } as Anthropic.Messages.TextBlockParam,
                  ],
          });
          repairCount++;
        } else {
          result.push(msg);
        }
      }
    } else {
      result.push(msg);
    }
  }

  // Also handle the case where the last message is an assistant message with tool_use
  // but there's no following user message with tool_result (edge case for the final message)
  // This is fine — the API only requires tool_result to reference a preceding tool_use,
  // not that every tool_use has a tool_result.

  if (repairCount > 0) {
    logger.warn(
      `repairToolUseResultPairing: fixed ${repairCount} broken tool_use/tool_result pairings`,
    );
  }

  return result;
}

/**
 * Repair tool_use/tool_result pairing in the final VS Code message array.
 *
 * After conversion, system prompts are prepended as User messages, which can
 * break the tool pairing invariant (every LanguageModelToolResultPart in a User
 * message must have a matching LanguageModelToolCallPart in the immediately
 * preceding Assistant message).
 *
 * This function scans the converted messages and converts any orphaned
 * LanguageModelToolResultPart into LanguageModelTextPart so the Copilot
 * backend won't reject the request.
 */
export function repairVSCodeToolPairing(
  messages: vscode.LanguageModelChatMessage[],
): vscode.LanguageModelChatMessage[] {
  let repairCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Only check User messages (role === 1 for User in VS Code API)
    if (msg.role !== vscode.LanguageModelChatMessageRole.User) {
      continue;
    }

    // Collect tool_call IDs from the preceding Assistant message
    const prevMsg = i > 0 ? messages[i - 1] : null;
    const assistantToolCallIds = new Set<string>();
    if (
      prevMsg &&
      prevMsg.role === vscode.LanguageModelChatMessageRole.Assistant
    ) {
      for (const part of prevMsg.content) {
        if (part instanceof vscode.LanguageModelToolCallPart) {
          assistantToolCallIds.add(part.callId);
        }
      }
    }

    // Check each part of the user message
    let hasOrphanedToolResults = false;
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        if (!assistantToolCallIds.has(part.callId)) {
          hasOrphanedToolResults = true;
          break;
        }
      }
    }

    if (!hasOrphanedToolResults) {
      continue;
    }

    // Rebuild the content array, converting orphaned tool results to text
    const newContent: Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart
    > = [];
    for (const part of msg.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        if (!assistantToolCallIds.has(part.callId)) {
          // Convert orphaned tool result to text
          const textContent =
            part.content
              ?.map((c: any) =>
                c instanceof vscode.LanguageModelTextPart
                  ? c.value
                  : JSON.stringify(c),
              )
              .join("\n") || "";
          newContent.push(
            new vscode.LanguageModelTextPart(
              `[Tool result for ${part.callId}]: ${textContent}`,
            ),
          );
          logger.debug(
            `repairVSCodeToolPairing: converted orphaned tool result ${part.callId} to text at vsCode message index ${i}`,
          );
          repairCount++;
        } else {
          newContent.push(part);
        }
      } else {
        newContent.push(part as vscode.LanguageModelTextPart);
      }
    }

    // Replace the message in-place
    messages[i] = vscode.LanguageModelChatMessage.User(newContent);
  }

  if (repairCount > 0) {
    logger.warn(
      `repairVSCodeToolPairing: converted ${repairCount} orphaned tool result(s) to text in VS Code messages`,
    );
  }

  return messages;
}

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
  tools?.map((tool) => {
    const t = tool as Anthropic.Messages.Tool;
    if (t.input_schema) {
      return {
        name: t.name,
        description: t.description || "",
        inputSchema: t.input_schema,
      };
    }
    // For built-in tools like ToolBash20250124 that don't have input_schema
    return {
      name: t.name,
      description: t.description || (tool as { type?: string }).type || "",
      inputSchema: tool,
    };
  });

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
