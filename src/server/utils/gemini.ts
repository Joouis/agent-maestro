import {
  type Content,
  type FunctionCallingConfig,
  FunctionCallingConfigMode,
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
  | vscode.LanguageModelToolResultPart => {
  // Text part
  if (part.text !== undefined) {
    return new vscode.LanguageModelTextPart(part.text);
  }

  // Function call (tool use)
  if (part.functionCall?.name) {
    // [Question] How to handle thoughtSignature? (https://ai.google.dev/gemini-api/docs/thought-signatures)
    return new vscode.LanguageModelToolCallPart(
      part.functionCall.id || `function_call_${Date.now()}`,
      part.functionCall.name,
      (part.functionCall.args || {}) as object,
    );
  }

  // Function response (tool result)
  if (part.functionResponse?.id) {
    const responseText = part.functionResponse.response
      ? JSON.stringify(part.functionResponse.response)
      : "";
    return new vscode.LanguageModelToolResultPart(part.functionResponse.id, [
      new vscode.LanguageModelTextPart(responseText),
    ]);
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

  // Unknown part type - represent as text to avoid data loss
  return new vscode.LanguageModelTextPart(JSON.stringify(part));
};

/**
 * Convert a single Gemini Content to VSCode LanguageModelChatMessage
 */
export const convertGeminiContentToVSCode = (
  content: Content,
): vscode.LanguageModelChatMessage => {
  const parts = (content.parts || []).map(convertGeminiPartToVSCodePart);

  // Default to empty text if no valid parts
  if (parts.length === 0) {
    parts.push(new vscode.LanguageModelTextPart(""));
  }

  // Convert role: "user" or "model" -> User or Assistant
  const role = content.role || "user";
  if (role === "model") {
    return vscode.LanguageModelChatMessage.Assistant(
      parts.filter(
        (p) => !(p instanceof vscode.LanguageModelToolResultPart),
      ) as Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
      >,
    );
  }

  return vscode.LanguageModelChatMessage.User(
    parts.filter(
      (p) => !(p instanceof vscode.LanguageModelToolCallPart),
    ) as Array<
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
  instruction?: Content,
): vscode.LanguageModelChatMessage[] => {
  const parts = (instruction?.parts || [])
    .map(convertGeminiPartToVSCodePart)
    .filter((p) => !(p instanceof vscode.LanguageModelToolCallPart)) as Array<
    vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart
  >;

  return parts.length > 0 ? [vscode.LanguageModelChatMessage.User(parts)] : [];
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
        // Skip function declarations without a name
        if (!funcDecl.name) {
          continue;
        }
        vsCodeTools.push({
          name: funcDecl.name,
          description: funcDecl.description || "",
          inputSchema:
            funcDecl.parameters || funcDecl.parametersJsonSchema || {},
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
  if (!config?.mode) {
    return undefined;
  }

  switch (config.mode) {
    case FunctionCallingConfigMode.AUTO:
    case FunctionCallingConfigMode.VALIDATED:
      return vscode.LanguageModelChatToolMode.Auto;
    case FunctionCallingConfigMode.ANY:
      return vscode.LanguageModelChatToolMode.Required;
    default:
      return undefined;
  }
};
