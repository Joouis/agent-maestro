import {
  type Content,
  type ContentUnion,
  type FunctionCallingConfig,
  type Part,
  type Tool,
} from "@google/genai";
import * as vscode from "vscode";

/**
 * Convert a single Gemini Part to VSCode LanguageModelChatMessage parts
 */
const convertGeminiPartToVSCodePart = (
  part: Part,
):
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelToolResultPart
  | null => {
  // Text part
  if (part.text !== undefined) {
    return new vscode.LanguageModelTextPart(part.text);
  }

  // Function call (tool use)
  if (part.functionCall) {
    return new vscode.LanguageModelToolCallPart(
      part.functionCall.id || `call_${Date.now()}`,
      part.functionCall.name || "unknown",
      (part.functionCall.args || {}) as object,
    );
  }

  // Function response (tool result)
  if (part.functionResponse) {
    const responseText = part.functionResponse.response
      ? JSON.stringify(part.functionResponse.response)
      : "";
    return new vscode.LanguageModelToolResultPart(
      part.functionResponse.id || "",
      [new vscode.LanguageModelTextPart(responseText)],
    );
  }

  // Inline data (images, etc.) - try to use LanguageModelDataPart if available
  if (part.inlineData) {
    const LanguageModelDataPart = (vscode as any).LanguageModelDataPart;
    if (LanguageModelDataPart && part.inlineData.data) {
      try {
        const buffer = Buffer.from(part.inlineData.data, "base64");
        return new LanguageModelDataPart(
          buffer,
          part.inlineData.mimeType || "application/octet-stream",
        );
      } catch {
        // Fallback to text representation
        return new vscode.LanguageModelTextPart(
          JSON.stringify(part.inlineData),
        );
      }
    }
    // Fallback to text representation
    return new vscode.LanguageModelTextPart(JSON.stringify(part.inlineData));
  }

  // File data - represent as text
  if (part.fileData) {
    return new vscode.LanguageModelTextPart(JSON.stringify(part.fileData));
  }

  // Unknown part type
  return null;
};

/**
 * Convert a single Gemini Content to VSCode LanguageModelChatMessage
 */
export const convertGeminiContentToVSCode = (
  content: Content,
): vscode.LanguageModelChatMessage => {
  const parts = (content.parts || [])
    .map(convertGeminiPartToVSCodePart)
    .filter((p) => p !== null) as Array<
    | vscode.LanguageModelTextPart
    | vscode.LanguageModelToolCallPart
    | vscode.LanguageModelToolResultPart
  >;

  // Default to empty text if no valid parts
  if (parts.length === 0) {
    parts.push(new vscode.LanguageModelTextPart(""));
  }

  // Convert role: "user" or "model" -> User or Assistant
  const role = content.role || "user";
  if (role === "model") {
    return vscode.LanguageModelChatMessage.Assistant(
      parts as Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
      >,
    );
  }

  return vscode.LanguageModelChatMessage.User(
    parts as Array<
      vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart
    >,
  );
};

/**
 * Convert Gemini Contents array to VSCode LanguageModelChatMessages
 */
export const convertGeminiContentsToVSCode = (
  contents: Content[],
): vscode.LanguageModelChatMessage[] => {
  return contents.map(convertGeminiContentToVSCode);
};

/**
 * Convert Gemini systemInstruction to VSCode LanguageModelChatMessages
 * System instructions are treated as User messages in VSCode LM API
 */
export const convertGeminiSystemInstructionToVSCode = (
  instruction?: ContentUnion,
): vscode.LanguageModelChatMessage[] => {
  if (!instruction) {
    return [];
  }

  // String format
  if (typeof instruction === "string") {
    return [vscode.LanguageModelChatMessage.User(instruction)];
  }

  // Single Part format
  if ("text" in instruction || "functionCall" in instruction) {
    const part = convertGeminiPartToVSCodePart(instruction as Part);
    if (part) {
      return [vscode.LanguageModelChatMessage.User([part])];
    }
    return [];
  }

  // Array of Parts format
  if (Array.isArray(instruction)) {
    const parts = instruction
      .map(convertGeminiPartToVSCodePart)
      .filter(
        (p) => p !== null && p instanceof vscode.LanguageModelTextPart,
      ) as vscode.LanguageModelTextPart[];

    if (parts.length > 0) {
      return [vscode.LanguageModelChatMessage.User(parts)];
    }
    return [];
  }

  // Content format
  if ("parts" in instruction || "role" in instruction) {
    return [convertGeminiContentToVSCode(instruction as Content)];
  }

  return [];
};

/**
 * Convert Gemini Tools to VSCode LanguageModelChatTools
 */
export const convertGeminiToolsToVSCode = (
  tools?: Tool[],
): vscode.LanguageModelChatTool[] | undefined => {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const vsCodeTools: vscode.LanguageModelChatTool[] = [];

  for (const tool of tools) {
    if (tool.functionDeclarations) {
      for (const funcDecl of tool.functionDeclarations) {
        vsCodeTools.push({
          name: funcDecl.name,
          description: funcDecl.description || "",
          inputSchema: funcDecl.parameters || {},
        });
      }
    }
  }

  return vsCodeTools.length > 0 ? vsCodeTools : undefined;
};

/**
 * Convert Gemini FunctionCallingConfig to VSCode LanguageModelChatToolMode
 */
export const convertGeminiToolConfigToVSCode = (
  config?: FunctionCallingConfig,
): vscode.LanguageModelChatToolMode | undefined => {
  if (!config || !config.mode) {
    return undefined;
  }

  switch (config.mode) {
    case "AUTO":
      return vscode.LanguageModelChatToolMode.Auto;
    case "ANY":
      return vscode.LanguageModelChatToolMode.Required;
    case "NONE":
    default:
      return undefined;
  }
};
