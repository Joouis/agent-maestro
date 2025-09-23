import OpenAI from "openai";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

const convertOpenAIChatCompletionContentPartToUserContent = (
  part: OpenAI.ChatCompletionContentPart,
): vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart => {
  if (part.type === "text") {
    return new vscode.LanguageModelTextPart(part.text);
  }

  /**
   * Not supported content part types in user messages:
   * - ChatCompletionContentPartImage
   * - ChatCompletionContentPartInputAudio
   * - ChatCompletionContentPart.File
   *
   * Fallback: serialize to JSON string
   */
  return new vscode.LanguageModelTextPart(JSON.stringify(part));
};

/**
 * Convert OpenAI messages to VSCode Language Model messages
 */
export const convertOpenAIMessagesToVSCode = (
  messages: OpenAI.ChatCompletionMessageParam[],
): vscode.LanguageModelChatMessage[] => {
  return messages.map((msg) => {
    // Handle different content formats
    let content;

    // Map roles to VSCode LM format
    switch (msg.role) {
      case "developer": // ChatCompletionDeveloperMessageParam
      case "system": // ChatCompletionSystemMessageParam
        content =
          typeof msg.content === "string"
            ? msg.content
            : msg.content.map((m) => ({
                value: m.text,
              }));
        return new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          content,
        );

      case "user": // ChatCompletionUserMessageParam
        if (typeof msg.content === "string") {
          return vscode.LanguageModelChatMessage.User(msg.content);
        }
        return vscode.LanguageModelChatMessage.User(
          msg.content.map(convertOpenAIChatCompletionContentPartToUserContent),
        );

      case "assistant": // ChatCompletionAssistantMessageParam
        content = [];
        if (typeof msg.content === "string") {
          content.push(new vscode.LanguageModelTextPart(msg.content));
        } else if (Array.isArray(msg.content)) {
          msg.content.forEach((c) => {
            if (c.type === "text") {
              content.push(new vscode.LanguageModelTextPart(c.text));
            } else {
              // ChatCompletionContentPartRefusal
              content.push(new vscode.LanguageModelTextPart(JSON.stringify(c)));
            }
          });
        }

        // ChatCompletionMessageCustomToolCall
        msg.tool_calls?.forEach((toolCall) => {
          let input = {};
          if (toolCall.type === "function") {
            // ChatCompletionMessageFunctionToolCall
            try {
              input = JSON.parse(toolCall.function.arguments);
            } catch (e) {
              logger.error("Failed to parse function tool call input", e);
            }
            content.push(
              new vscode.LanguageModelToolCallPart(
                toolCall.id,
                toolCall.function.name,
                input,
              ),
            );
          } else if (toolCall.type === "custom") {
            // ChatCompletionMessageCustomToolCall
            try {
              input = JSON.parse(toolCall.custom.input);
            } catch (e) {
              logger.error("Failed to parse custom tool call input", e);
            }
            content.push(
              new vscode.LanguageModelToolCallPart(
                toolCall.id,
                toolCall.custom.name,
                input,
              ),
            );
          }
        });
        return vscode.LanguageModelChatMessage.Assistant(content);

      case "tool": // ChatCompletionToolMessageParam
        // Tool messages should be converted to LanguageModelToolResultPart
        content =
          typeof msg.content === "string"
            ? [new vscode.LanguageModelTextPart(msg.content)]
            : msg.content;
        return vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(msg.tool_call_id, content),
        ]);

      default: // Fallback for unknown roles
        return vscode.LanguageModelChatMessage.Assistant(
          "Unknown role message: " + JSON.stringify(msg),
        );
    }
  });
};

export const convertOpenAIChatCompletionToolToVSCode = (
  tool: OpenAI.ChatCompletionTool,
): vscode.LanguageModelChatTool => {
  if (tool.type === "function") {
    // FunctionDefinition
    return {
      name: tool.function.name,
      description: tool.function.description || "",
      inputSchema: tool.function.parameters,
    };
  }

  // CustomToolDefinition, not sure if the custom.format could work as inputSchema
  return {
    name: tool.custom.name,
    description: tool.custom.description || "",
    inputSchema: tool.custom.format,
  };
};
