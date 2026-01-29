import {
  type Content,
  type FunctionCallingConfig,
  FunctionCallingConfigMode,
  type Part,
  type Schema,
  type Tool,
} from "@google/genai";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";

/**
 * Map of uppercase/mixed-case type values to lowercase JSON Schema types.
 * Handles Protocol Buffer style (OBJECT), mixed case (Object), and edge cases.
 */
const TYPE_NORMALIZATION_MAP: Record<string, string> = {
  // Uppercase (Protocol Buffer style)
  STRING: "string",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  ARRAY: "array",
  OBJECT: "object",
  NULL: "null",
  // Mixed case (just in case)
  String: "string",
  Number: "number",
  Integer: "integer",
  Boolean: "boolean",
  Array: "array",
  Object: "object",
  Null: "null",
};

/**
 * Fields that contain arbitrary user data and should NOT be recursively traversed.
 * These may contain objects with "type" properties that are not JSON Schema types.
 * - default/example/const: Can contain any user-defined data
 * - enum: Contains literal values for exact matching, not schema definitions
 */
const NON_SCHEMA_FIELDS = new Set(["default", "example", "const", "enum"]);

/**
 * Maximum depth for recursive schema traversal to prevent stack overflow.
 */
const MAX_SCHEMA_DEPTH = 100;

/**
 * Normalize JSON Schema type values from uppercase (Protocol Buffer style)
 * to lowercase (JSON Schema style).
 * Recursively processes all nested schemas using generic traversal.
 *
 * @param schema - The schema to normalize (can be any value)
 * @param visited - WeakSet to track visited objects and prevent circular reference loops
 * @param depth - Current recursion depth (used to prevent stack overflow)
 * @returns The normalized schema with lowercase type values
 */
export const normalizeSchemaTypes = (
  schema: unknown,
  visited = new WeakSet<object>(),
  depth = 0,
): unknown => {
  // Guard against null, undefined, or non-object (primitives pass through)
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  // Prevent stack overflow from deeply nested schemas
  if (depth >= MAX_SCHEMA_DEPTH) {
    logger.warn(
      `Schema normalization reached max depth (${MAX_SCHEMA_DEPTH}), returning value as-is`,
    );
    return schema;
  }

  // Prevent infinite loops from circular references
  if (visited.has(schema as object)) {
    return schema;
  }
  visited.add(schema as object);

  // Handle arrays - recurse into each element
  if (Array.isArray(schema)) {
    return schema.map((item) => normalizeSchemaTypes(item, visited, depth + 1));
  }

  // Handle objects - traverse all fields
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      // Normalize the type field
      const upperType = value.toUpperCase();
      if (upperType === "TYPE_UNSPECIFIED") {
        // Skip TYPE_UNSPECIFIED - it's invalid and should be removed
        continue;
      }
      normalized[key] = TYPE_NORMALIZATION_MAP[value] ?? value.toLowerCase();
    } else if (NON_SCHEMA_FIELDS.has(key)) {
      // Don't recurse into non-schema fields that contain arbitrary user data
      normalized[key] = value;
    } else {
      // Recurse into all other fields
      normalized[key] = normalizeSchemaTypes(value, visited, depth + 1);
    }
  }
  return normalized;
};

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

        const name = funcDecl.name;
        const description = funcDecl.description || "";
        const rawSchema = (funcDecl.parameters ||
          funcDecl.parametersJsonSchema ||
          {}) as Schema;

        // Normalize type fields from uppercase (OBJECT, STRING) to lowercase (object, string)
        // to ensure compatibility with VSCode Language Model API which expects JSON Schema style
        const inputSchema = normalizeSchemaTypes(rawSchema) as Schema;

        // Only convert schemas with `type` or `anyOf` properties to avoid "400 Bad Request" errors.
        // For the "delegate_to_agent" tool, some tests show that the LLM can select the correct
        // "agent_name" when it appears alongside other properties in the same schema.
        // However, Gemini CLI fails to invoke the function and returns an "Incomplete JSON segment at the end" error.
        if (inputSchema.type) {
          vsCodeTools.push({
            name,
            description,
            inputSchema,
          });
        } else if (
          Array.isArray(inputSchema.anyOf) &&
          name === "delegate_to_agent"
        ) {
          let enhancedDescription = `This function has multiple input schemas. Please choose the appropriate schema when calling the function.`;

          const schema = {
            type: "object",
            properties: {
              agent_name: {
                type: "string",
                description:
                  "Read function description to learn different agent names and usages",
              },
            },
            required: ["agent_name"],
          };
          inputSchema.anyOf.forEach((subSchema) => {
            const agentNameProp = subSchema.properties?.agent_name as any;
            if (agentNameProp && agentNameProp.const) {
              enhancedDescription += `\n\n## ${agentNameProp.const}\n\`\`\`json\n${JSON.stringify(
                subSchema,
                null,
                2,
              )}\n\`\`\``;
              for (const key in subSchema.properties) {
                if (key !== "agent_name") {
                  (schema.properties as Record<string, unknown>)[key] =
                    subSchema.properties[key];
                }
              }
            }
          });

          vsCodeTools.push({
            name,
            description: enhancedDescription,
            inputSchema: schema,
          });
        } else {
          logger.warn(
            `Skipping Gemini tool "${name}": schema structure not supported for conversion`,
          );
          logger.info(`Schema: ${JSON.stringify(inputSchema, null, 2)}`);
        }
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
