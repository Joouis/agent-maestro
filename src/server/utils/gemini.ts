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
import { extractCopilotUsagePayload } from "./copilotUsage";
import { mimeForVscodeLm } from "./imageMime";

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
  resolvedCallId?: string,
):
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelToolResultPart
  | vscode.LanguageModelDataPart => {
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

  // Function response (tool result).
  // Some Gemini clients (e.g. langchain-google-genai) only send `name` on
  // functionResponse parts and rely on Gemini's positional pairing rules,
  // omitting `id`. The original strict `if (part.functionResponse?.id)` check
  // dropped those parts entirely, leading the upstream LM API to reject the
  // turn with "function response parts != function call parts". Fall back to
  // a callId resolved by the caller (positional FIFO match against the
  // preceding functionCall) and finally to a synthetic name-based id.
  if (part.functionResponse) {
    const callId =
      part.functionResponse.id ||
      resolvedCallId ||
      (part.functionResponse.name
        ? `function_call_${part.functionResponse.name}`
        : undefined);
    if (callId) {
      const responseText = part.functionResponse.response
        ? JSON.stringify(part.functionResponse.response)
        : "";
      return new vscode.LanguageModelToolResultPart(callId, [
        new vscode.LanguageModelTextPart(responseText),
      ]);
    }
  }

  // Inline data (images, etc.)
  if (part.inlineData) {
    if (part.inlineData.data) {
      const buffer = Buffer.from(part.inlineData.data, "base64");
      const mimeType = part.inlineData.mimeType || "application/octet-stream";
      // mimeForVscodeLm sniffs the bytes; non-image data (audio, etc.) has no
      // readable dimensions and is returned unchanged, so this is safe to call
      // unconditionally — and it lets images mislabeled as octet-stream still
      // be corrected.
      return new vscode.LanguageModelDataPart(
        buffer,
        mimeForVscodeLm(buffer, mimeType),
      );
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
  const parts = (content.parts || []).map((part) =>
    convertGeminiPartToVSCodePart(part),
  );

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
        | vscode.LanguageModelTextPart
        | vscode.LanguageModelToolCallPart
        | vscode.LanguageModelDataPart
      >,
    );
  }

  return vscode.LanguageModelChatMessage.User(
    parts.filter(
      (p) => !(p instanceof vscode.LanguageModelToolCallPart),
    ) as Array<
      | vscode.LanguageModelTextPart
      | vscode.LanguageModelToolResultPart
      | vscode.LanguageModelDataPart
    >,
  );
};

/**
 * Convert Gemini Contents array to VSCode LanguageModelChatMessages.
 *
 * Why this isn't just `contents.map(convertGeminiContentToVSCode)`: Gemini's
 * API allows clients to send `functionCall`/`functionResponse` parts WITHOUT
 * an explicit `id`, relying on positional pairing within the `contents` array
 * (langchain-google-genai 4.x does this). VSCode's LanguageModel API on the
 * other hand REQUIRES a callId on every tool result and matches it against
 * the preceding tool-call. Without pairing here, every tool-using Gemini
 * conversation through this proxy fails with
 *   "Please ensure that the number of function response parts is equal to
 *    the number of function call parts of the function call turn."
 *
 * Strategy: walk all parts in document order, assigning a stable callId to
 * each functionCall (using its `id` when present, else a synthetic id), and
 * push that callId onto a per-name FIFO queue. When we then encounter a
 * functionResponse without an `id`, we drain the queue for that name to
 * recover the matching callId.
 */
export const convertGeminiContentsToVSCode = (
  contents: Content[],
): vscode.LanguageModelChatMessage[] => {
  // Pre-walk: assign a callId to every functionCall and remember it on the
  // part itself (via WeakMap), and build a per-name FIFO queue we'll drain
  // during the conversion pass.
  const callIdByPart = new WeakMap<object, string>();
  const pendingByName = new Map<string, string[]>();
  let synthCounter = 0;
  for (const content of contents) {
    for (const part of content.parts || []) {
      if (part.functionCall?.name) {
        const callId =
          part.functionCall.id ||
          `function_call_synth_${synthCounter++}_${part.functionCall.name}`;
        callIdByPart.set(part as unknown as object, callId);
        const queue = pendingByName.get(part.functionCall.name) || [];
        queue.push(callId);
        pendingByName.set(part.functionCall.name, queue);
      }
    }
  }

  const turnCallCounts = new Map<string, number>();
  const turnResultIds = new Set<string>();
  let previousWasModel = false;
  let duplicateResultCount = 0;
  const messages = contents.flatMap((content) => {
    const isModel = content.role === "model";
    if (isModel) {
      if (!previousWasModel) {
        turnCallCounts.clear();
        turnResultIds.clear();
      }
      for (const part of content.parts || []) {
        const call = part.functionCall;
        if (call?.name && typeof call.id === "string" && call.id.length > 0) {
          turnCallCounts.set(call.id, (turnCallCounts.get(call.id) || 0) + 1);
        }
      }
    }
    previousWasModel = isModel;

    let droppedDuplicate = false;
    const parts = (content.parts || []).flatMap((part) => {
      // CLI restore can repeat results within a turn. A later call with the
      // same ID needs its own result, and id-less results are not identifiable.
      const resultId = part.functionResponse?.id;
      if (
        !isModel &&
        typeof resultId === "string" &&
        turnCallCounts.get(resultId) === 1
      ) {
        if (turnResultIds.has(resultId)) {
          droppedDuplicate = true;
          duplicateResultCount++;
          return [];
        }
        turnResultIds.add(resultId);
      }
      // For functionCall: use the pre-assigned callId so the tool-result side
      // has something to match against.
      if (part.functionCall?.name) {
        const callId = callIdByPart.get(part as unknown as object);
        if (callId) {
          return new vscode.LanguageModelToolCallPart(
            callId,
            part.functionCall.name,
            (part.functionCall.args || {}) as object,
          );
        }
      }
      // For functionResponse: keep the per-name pending queue in sync.
      // If an explicit id is present, remove that matched callId so it cannot
      // later be reused by an id-less response for the same function name.
      // Otherwise, drain the FIFO queue for the matching name and pass that
      // callId into the part converter so it produces a properly-paired
      // LanguageModelToolResultPart.
      let resolvedCallId: string | undefined;
      if (part.functionResponse?.name) {
        const queue = pendingByName.get(part.functionResponse.name);
        if (queue && queue.length > 0) {
          if (part.functionResponse.id) {
            const matchedIndex = queue.indexOf(part.functionResponse.id);
            if (matchedIndex !== -1) {
              queue.splice(matchedIndex, 1);
            }
          } else {
            resolvedCallId = queue.shift();
          }
        }
      }
      return convertGeminiPartToVSCodePart(part, resolvedCallId);
    });

    if (parts.length === 0) {
      if (droppedDuplicate) {
        return [];
      }
      parts.push(new vscode.LanguageModelTextPart(""));
    }

    const role = content.role || "user";
    if (role === "model") {
      return vscode.LanguageModelChatMessage.Assistant(
        parts.filter(
          (p) => !(p instanceof vscode.LanguageModelToolResultPart),
        ) as Array<
          | vscode.LanguageModelTextPart
          | vscode.LanguageModelToolCallPart
          | vscode.LanguageModelDataPart
        >,
      );
    }
    return vscode.LanguageModelChatMessage.User(
      parts.filter(
        (p) => !(p instanceof vscode.LanguageModelToolCallPart),
      ) as Array<
        | vscode.LanguageModelTextPart
        | vscode.LanguageModelToolResultPart
        | vscode.LanguageModelDataPart
      >,
    );
  });

  if (duplicateResultCount > 0) {
    logger.warn(
      `Gemini tool result recovery: dropped ${duplicateResultCount} duplicate result(s) within tool-call turns`,
    );
  }
  return messages;
};

/**
 * Convert Gemini systemInstruction to VSCode LanguageModelChatMessages
 * System instructions are treated as User messages in VSCode LM API
 */
export const convertGeminiSystemInstructionToVSCode = (
  instruction?: Content,
): vscode.LanguageModelChatMessage[] => {
  const parts = (instruction?.parts || [])
    .map((part) => convertGeminiPartToVSCodePart(part))
    .filter((p) => !(p instanceof vscode.LanguageModelToolCallPart)) as Array<
    | vscode.LanguageModelTextPart
    | vscode.LanguageModelToolResultPart
    | vscode.LanguageModelDataPart
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

export interface GeminiTokenUsage {
  cachedContentTokenCount: number;
  candidatesTokenCount: number;
  promptTokenCount: number;
  thoughtsTokenCount: number;
  totalTokenCount: number;
}

const asNonNegativeFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

export const extractGeminiUsage = (
  chunk: vscode.LanguageModelDataPart,
): GeminiTokenUsage | undefined => {
  const usage = extractCopilotUsagePayload(chunk);
  if (!usage) {
    return undefined;
  }

  const cachedTokens =
    asNonNegativeFiniteNumber(usage.prompt_tokens_details?.cached_tokens) ?? 0;
  const reasoningTokens =
    asNonNegativeFiniteNumber(
      usage.completion_tokens_details?.reasoning_tokens,
    ) ??
    asNonNegativeFiniteNumber(
      (usage as { reasoning_tokens?: unknown }).reasoning_tokens,
    ) ??
    0;
  const totalTokens = asNonNegativeFiniteNumber(usage.total_tokens);
  const promptTokenCount = Math.max(0, usage.prompt_tokens - cachedTokens);

  return {
    cachedContentTokenCount: cachedTokens,
    candidatesTokenCount: usage.completion_tokens,
    promptTokenCount,
    thoughtsTokenCount: reasoningTokens,
    totalTokenCount:
      totalTokens ??
      usage.prompt_tokens + usage.completion_tokens + reasoningTokens,
  };
};
