import crypto from "crypto";
import { SSEStreamingApi } from "hono/streaming";
import {
  EasyInputMessage,
  FunctionTool,
  NamespaceTool,
  ResponseCustomToolCall,
  ResponseCustomToolCallOutput,
  ResponseFunctionToolCall,
  ResponseInput,
  ResponseInputContent,
  ResponseInputImage,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  Tool,
  ToolChoiceAllowed,
  ToolChoiceApplyPatch,
  ToolChoiceCustom,
  ToolChoiceFunction,
  ToolChoiceMcp,
  ToolChoiceOptions,
  ToolChoiceShell,
  ToolChoiceTypes,
} from "openai/resources/responses/responses";
import * as vscode from "vscode";

import { logger } from "../../utils/logger";
import { mimeForVscodeLm } from "./imageMime";

/**
 * Import types from OpenAI SDK for Responses API
 */
export type ToolChoice =
  | ToolChoiceOptions
  | ToolChoiceAllowed
  | ToolChoiceTypes
  | ToolChoiceFunction
  | ToolChoiceMcp
  | ToolChoiceCustom
  | ToolChoiceApplyPatch
  | ToolChoiceShell;

export type ResponseTool = Tool;

/**
 * Output item types for Responses API (subset we generate)
 */
export type OutputItem =
  | ResponseOutputMessage
  | ResponseFunctionToolCall
  | ResponseCustomToolCall;

/**
 * Generate random string for IDs using crypto
 */
const randomString = (length: number): string => {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(bytes[i] % chars.length);
  }
  return result;
};

/**
 * Generate unique response ID
 */
export const generateResponseId = (): string =>
  `resp_AM-${Date.now()}-${randomString(8)}`;

/**
 * Generate unique message ID
 */
export const generateMessageId = (): string => `msg_AM-${randomString(12)}`;

/**
 * Generate unique function call ID
 */
export const generateFunctionCallId = (): string => `fc_AM-${randomString(12)}`;

/**
 * Generate unique custom tool call ID
 */
export const generateCustomToolCallId = (): string =>
  `ctc_AM-${randomString(12)}`;

/**
 * Get current Unix timestamp in seconds
 */
export const getCurrentTimestamp = (): number => Math.floor(Date.now() / 1000);

/**
 * Helper for closing a message output item in streaming responses
 */
export const closeMessageOutputItem = async (
  sseStream: SSEStreamingApi,
  messageId: string,
  outputIndex: number,
  contentIndex: number,
  accumulatedText: string,
  sequenceNumberRef?: { value: number },
): Promise<OutputItem> => {
  const nextSeq = () =>
    sequenceNumberRef ? sequenceNumberRef.value++ : undefined;

  await sseStream.writeSSE({
    event: "response.output_text.done",
    data: JSON.stringify({
      type: "response.output_text.done",
      item_id: messageId,
      output_index: outputIndex,
      content_index: contentIndex,
      text: accumulatedText,
      sequence_number: nextSeq(),
    }),
  });

  await sseStream.writeSSE({
    event: "response.content_part.done",
    data: JSON.stringify({
      type: "response.content_part.done",
      item_id: messageId,
      output_index: outputIndex,
      content_index: contentIndex,
      part: {
        type: "output_text",
        text: accumulatedText,
        annotations: [],
      },
      sequence_number: nextSeq(),
    }),
  });

  const outputItem: OutputItem = {
    type: "message",
    id: messageId,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: accumulatedText,
        annotations: [],
      },
    ],
    status: "completed",
  };

  await sseStream.writeSSE({
    event: "response.output_item.done",
    data: JSON.stringify({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: outputItem,
      sequence_number: nextSeq(),
    }),
  });

  return outputItem;
};

/**
 * Convert input_image content to VSCode DataPart or TextPart
 */
const convertInputImageToVSCodePart = (
  content: ResponseInputImage,
): vscode.LanguageModelTextPart | vscode.LanguageModelDataPart => {
  if (content.image_url) {
    // Parse data URI: data:image/png;base64,<data>
    const match = content.image_url.match(
      /^data:(image\/[\w+.-]+);base64,(.+)$/,
    );
    if (match) {
      const mimeType = match[1];
      const base64Data = match[2];
      const bytes = Buffer.from(base64Data, "base64");
      return new vscode.LanguageModelDataPart(
        bytes,
        mimeForVscodeLm(bytes, mimeType),
      );
    }
  }
  // URL-based images or file_id are not directly supported by VS Code LM.
  logger.warn("input_image not fully supported, serializing as JSON");
  return new vscode.LanguageModelTextPart(JSON.stringify(content));
};

/**
 * Convert a single input content part to VSCode part
 */
export const convertInputContentToVSCodePart = (
  content: ResponseInputContent | ResponseOutputText,
): vscode.LanguageModelTextPart | vscode.LanguageModelDataPart => {
  // `encrypted_content` is an opaque encrypted reasoning blob (Codex/OpenAI
  // round-trips it back to the provider). It's not in the SDK content union.
  // VSCode LM can't decrypt or use it, and dumping the ciphertext into the
  // prompt is harmful, so drop it.
  if ((content as { type?: string }).type === "encrypted_content") {
    logger.debug("Dropping encrypted_content part (not usable by VSCode LM)");
    return new vscode.LanguageModelTextPart("");
  }
  switch (content.type) {
    case "input_text":
      return new vscode.LanguageModelTextPart(content.text ?? "");
    case "output_text":
      // Accept output_text for compatibility with persisted response content.
      return new vscode.LanguageModelTextPart(content.text ?? "");
    case "input_image":
      return convertInputImageToVSCodePart(content);
    case "input_file":
      logger.warn("input_file not supported, serializing as JSON");
      return new vscode.LanguageModelTextPart(JSON.stringify(content));
    default:
      logger.warn(
        `Unknown content type "${(content as any).type}", serializing as JSON`,
      );
      return new vscode.LanguageModelTextPart(JSON.stringify(content));
  }
};

/**
 * Check if item is an EasyInputMessage (shorthand format)
 */
const isEasyInputMessage = (item: unknown): item is EasyInputMessage => {
  return (
    typeof item === "object" &&
    item !== null &&
    "role" in item &&
    "content" in item &&
    (!("type" in item) || (item as Record<string, unknown>).type === "message")
  );
};

/**
 * Convert EasyInputMessage to VSCode LM message
 */
const convertEasyInputMessage = (
  msg: EasyInputMessage,
): vscode.LanguageModelChatMessage => {
  if (typeof msg.content === "string") {
    switch (msg.role) {
      case "user":
        return vscode.LanguageModelChatMessage.User(msg.content);
      case "assistant":
        return vscode.LanguageModelChatMessage.Assistant(msg.content);
      case "system":
      case "developer":
        return vscode.LanguageModelChatMessage.User(msg.content);
      default:
        return vscode.LanguageModelChatMessage.User(msg.content);
    }
  }

  const parts = msg.content.map(convertInputContentToVSCodePart);
  switch (msg.role) {
    case "user":
      return vscode.LanguageModelChatMessage.User(parts);
    case "assistant":
      return vscode.LanguageModelChatMessage.Assistant(parts);
    case "system":
    case "developer":
      return vscode.LanguageModelChatMessage.User(parts);
    default:
      return vscode.LanguageModelChatMessage.User(parts);
  }
};

/**
 * Convert ResponseInputItem.Message to VSCode LM message
 */
const convertInputMessage = (
  msg: ResponseInputItem.Message,
): vscode.LanguageModelChatMessage => {
  const parts = msg.content.map(convertInputContentToVSCodePart);
  switch (msg.role) {
    case "user":
      return vscode.LanguageModelChatMessage.User(parts);
    case "system":
    case "developer":
      return vscode.LanguageModelChatMessage.User(parts);
    default:
      return vscode.LanguageModelChatMessage.User(parts);
  }
};

/**
 * Convert a single input item to VSCode LM message
 */
export const convertResponsesItemToVSCode = (
  item: ResponseInputItem,
): vscode.LanguageModelChatMessage | null => {
  if (!item || typeof item !== "object") {
    return null;
  }

  const typedItem = item as unknown as Record<string, unknown>;

  // Handle function_call (ResponseFunctionToolCall)
  if (typedItem.type === "function_call") {
    const fc = item as ResponseFunctionToolCall;
    let input = {};
    try {
      input = JSON.parse(fc.arguments);
    } catch (e) {
      logger.warn("Failed to parse function_call arguments:", e);
    }
    // Namespaced tools are registered under an encoded name; re-encode so the
    // replayed call matches a tool the model can still see (see toolMap).
    const name = fc.namespace
      ? encodeNamespacedName(fc.namespace, fc.name)
      : fc.name;
    return vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart(fc.call_id, name, input),
    ]);
  }

  // Handle function_call_output
  if (typedItem.type === "function_call_output") {
    const fco = item as ResponseInputItem.FunctionCallOutput;
    // fco.output can be string or array of content items
    const outputText =
      typeof fco.output === "string" ? fco.output : JSON.stringify(fco.output);
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(fco.call_id, [
        new vscode.LanguageModelTextPart(outputText),
      ]),
    ]);
  }

  // Handle custom_tool_call (assistant call to a `custom` tool). Its `input`
  // is a raw string, not JSON. VSCode's tool call part requires an object
  // input, so wrap it; downstream consumers read the raw string back out.
  if (typedItem.type === "custom_tool_call") {
    const ctc = item as unknown as ResponseCustomToolCall;
    const name = ctc.namespace
      ? encodeNamespacedName(ctc.namespace, ctc.name)
      : ctc.name;
    return vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart(ctc.call_id, name, {
        input: ctc.input,
      }),
    ]);
  }

  // Handle custom_tool_call_output (result of a `custom` tool execution).
  if (typedItem.type === "custom_tool_call_output") {
    const ctco = item as unknown as ResponseCustomToolCallOutput;
    const outputText =
      typeof ctco.output === "string"
        ? ctco.output
        : JSON.stringify(ctco.output);
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(ctco.call_id, [
        new vscode.LanguageModelTextPart(outputText),
      ]),
    ]);
  }

  // Handle additional_tools (tools injected mid-conversation).
  // These carry no message content; their tools are merged separately via
  // extractAdditionalTools, so there is nothing to convert into a message.
  if (typedItem.type === "additional_tools") {
    return null;
  }

  // Handle agent_message (Codex sub-agent/collaboration inter-agent message).
  // Not part of the OpenAI SDK; its `content` is an array of input_* parts.
  // Surface it as a User message so the model sees the exchanged text, tagging
  // the author/recipient so provenance survives the flattening.
  if (typedItem.type === "agent_message") {
    const am = item as unknown as {
      author?: string;
      recipient?: string;
      content?: ResponseInputContent[];
    };
    const parts = (am.content ?? []).map(convertInputContentToVSCodePart);
    const header = `[agent_message${am.author ? ` from ${am.author}` : ""}${
      am.recipient ? ` to ${am.recipient}` : ""
    }]`;
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelTextPart(header),
      ...parts,
    ]);
  }

  // Handle item_reference (not supported)
  if (typedItem.type === "item_reference") {
    logger.warn(
      "item_reference is not supported without previous_response_id, skipping",
    );
    return null;
  }

  // Handle EasyInputMessage (has role and content, type is optional or "message")
  if (isEasyInputMessage(item)) {
    return convertEasyInputMessage(item as EasyInputMessage);
  }

  // Handle full InputMessage (ResponseInputItem.Message)
  if (typedItem.type === "message" && "content" in typedItem) {
    return convertInputMessage(item as unknown as ResponseInputItem.Message);
  }

  logger.warn("Unknown input item type, skipping:", typedItem.type);
  return null;
};

/**
 * Convert Responses API input to VSCode LM messages
 */
export const convertResponsesInputToVSCode = (
  input: string | ResponseInput | undefined,
  instruction?: string | ResponseInput | null,
): vscode.LanguageModelChatMessage[] => {
  const messages: vscode.LanguageModelChatMessage[] = [];

  // Add instruction as first user message if present
  if (instruction) {
    if (typeof instruction === "string") {
      messages.push(vscode.LanguageModelChatMessage.User(instruction));
    } else if (Array.isArray(instruction)) {
      for (const item of instruction) {
        const converted = convertResponsesItemToVSCode(item);
        if (converted) {
          messages.push(converted);
        }
      }
    }
  }

  // Handle string input
  if (typeof input === "string") {
    messages.push(vscode.LanguageModelChatMessage.User(input));
    return messages;
  }

  // Handle array input
  if (Array.isArray(input)) {
    for (const item of input) {
      const converted = convertResponsesItemToVSCode(item);
      if (converted) {
        messages.push(converted);
      }
    }
  }

  return messages;
};

/**
 * Convert Responses API tools to VSCode LM tools.
 *
 * VSCode's LanguageModelChatTool only models flat function-style tools
 * (name/description/inputSchema). Codex injects richer tool shapes via
 * `additional_tools`, so we flatten them here:
 *  - `function`: passed through directly.
 *  - `custom`: exposed as a schema-less tool (freeform/grammar input the model
 *    supplies as a raw string). The grammar/format hint cannot be represented
 *    in VSCode LM and is dropped, but the tool stays callable by name.
 *  - `namespace`: expanded into its nested function/custom tools. VSCode LM's
 *    tool-call shape has no namespace slot, so each nested tool is registered
 *    under an *encoded* name `<namespace>__<name>` to keep it unique across
 *    namespaces. The returned `toolMap` records how to decode that back into a
 *    separate `namespace` + bare `name` when serializing the model's tool call.
 * Other tool types (file_search, web_search, etc.) are not executable via
 * VSCode LM and are skipped.
 */
export const NAMESPACE_SEPARATOR = "__";

export const encodeNamespacedName = (namespace: string, name: string): string =>
  `${namespace}${NAMESPACE_SEPARATOR}${name}`;

export type ToolCallInfo = {
  namespace?: string;
  name: string;
  isCustom: boolean;
};

export type ToolMap = Map<string, ToolCallInfo>;

export type ConvertedTools = {
  tools: vscode.LanguageModelChatTool[];
  toolMap: ToolMap;
};

export const convertResponsesToolsToVSCode = (
  tools?: Tool[],
  options: { webSearchHandledByCopilotPatch?: boolean } = {},
): ConvertedTools => {
  const vsCodeTools: vscode.LanguageModelChatTool[] = [];
  const toolMap: ToolMap = new Map();
  if (!tools) {
    return { tools: vsCodeTools, toolMap };
  }

  const push = (
    encodedName: string,
    info: ToolCallInfo,
    description?: string | null,
    parameters?: unknown,
  ) => {
    if (toolMap.has(encodedName)) {
      logger.warn(
        `Duplicate tool definition for \"${encodedName}\"; keeping the first definition`,
      );
      return;
    }
    vsCodeTools.push({
      name: encodedName,
      description: description ?? "",
      inputSchema: info.isCustom
        ? undefined
        : ((parameters as object) ?? undefined),
    });
    toolMap.set(encodedName, info);
  };

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }

    if (tool.type === "function") {
      const funcTool = tool as FunctionTool;
      push(
        funcTool.name,
        { name: funcTool.name, isCustom: false },
        funcTool.description,
        funcTool.parameters,
      );
    } else if (tool.type === "custom") {
      push(tool.name, { name: tool.name, isCustom: true }, tool.description);
    } else if (tool.type === "namespace") {
      const ns = tool as NamespaceTool;
      for (const nested of ns.tools ?? []) {
        const encoded = encodeNamespacedName(ns.name, nested.name);
        if (nested.type === "custom") {
          push(
            encoded,
            { namespace: ns.name, name: nested.name, isCustom: true },
            nested.description,
          );
        } else {
          push(
            encoded,
            { namespace: ns.name, name: nested.name, isCustom: false },
            nested.description,
            nested.parameters,
          );
        }
      }
    } else if (
      !(options.webSearchHandledByCopilotPatch && isWebSearchTool(tool))
    ) {
      // Known tool types are expected and frequent, so keep the log at debug.
      logger.debug(`Tool type "${tool.type}" not supported, skipping`);
    }
  }

  return { tools: vsCodeTools, toolMap };
};

/**
 * Extract tools carried by `additional_tools` items in the input array.
 * These are tools the developer injects mid-conversation; they must be merged
 * with the request-level tools before being handed to the VSCode LM.
 */
export const extractAdditionalTools = (
  input: string | ResponseInput | undefined,
): Tool[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const tools: Tool[] = [];
  for (const item of input) {
    if (
      item &&
      typeof item === "object" &&
      (item as { type?: string }).type === "additional_tools"
    ) {
      const additional = item as ResponseInputItem.AdditionalTools;
      if (Array.isArray(additional.tools)) {
        tools.push(...additional.tools);
      }
    }
  }

  return tools;
};

export function getResponsesWebSearchTool(tools?: Tool[]): Tool | undefined {
  return tools?.find((tool) => !!tool && isWebSearchTool(tool));
}

function isWebSearchTool(tool: Tool): boolean {
  return typeof tool.type === "string" && tool.type.startsWith("web_search");
}

/**
 * Convert tool choice to VSCode LM tool mode
 */
export const convertToolChoice = (
  toolChoice?: ToolChoice,
): vscode.LanguageModelChatToolMode | undefined => {
  if (!toolChoice || toolChoice === "none") {
    return undefined;
  }
  if (
    toolChoice === "required" ||
    (typeof toolChoice === "object" &&
      (toolChoice.type === "function" || toolChoice.type === "custom"))
  ) {
    return vscode.LanguageModelChatToolMode.Required;
  }
  return vscode.LanguageModelChatToolMode.Auto; // Default for "auto"
};

/**
 * When `tool_choice` names a single tool (`{ type: "function" | "custom", name }`),
 * VSCode LM's `Required` mode can only force *some* tool call, not a *specific*
 * one. To honor the choice we narrow the exposed tool list to just that tool.
 *
 * `tool_choice` carries no namespace, so we match by the tool's bare name via
 * the `toolMap`, and additionally require the chosen `type` to agree with the
 * tool's kind (`function` ↔ non-custom, `custom` ↔ custom) so a named choice
 * can't select a tool of the wrong kind. Exactly one match narrows to it
 * (`ok: true`). Zero or multiple matches cannot be represented safely —
 * exposing every tool under `Required` would let the model call a *different*
 * tool than requested — so we report `ok: false` and let the caller reject.
 */
export type NarrowToolsResult =
  | { ok: true; tools: vscode.LanguageModelChatTool[] }
  | { ok: false; targetName: string; matchCount: number };

export const narrowToolsForChoice = (
  toolChoice: ToolChoice | undefined,
  vsCodeTools: vscode.LanguageModelChatTool[],
  toolMap: ToolMap,
): NarrowToolsResult => {
  if (
    !toolChoice ||
    typeof toolChoice !== "object" ||
    (toolChoice.type !== "function" && toolChoice.type !== "custom") ||
    !toolChoice.name
  ) {
    return { ok: true, tools: vsCodeTools };
  }

  const targetName = toolChoice.name;
  const wantCustom = toolChoice.type === "custom";
  const matches = vsCodeTools.filter((t) => {
    const info = toolMap.get(t.name);
    const name = info?.name ?? t.name;
    const isCustom = info?.isCustom ?? false;
    return name === targetName && isCustom === wantCustom;
  });

  if (matches.length === 1) {
    return { ok: true, tools: matches };
  }

  return { ok: false, targetName, matchCount: matches.length };
};

/**
 * Build output array from accumulated text and tool calls
 * Returns simplified output objects compatible with OpenAI Responses API
 */
export const buildResponseOutput = (
  accumulatedText: string,
  toolCalls: { callId: string; name: string; input: unknown }[],
  toolMap?: ToolMap,
): OutputItem[] => {
  const output: OutputItem[] = [];

  if (accumulatedText) {
    output.push({
      type: "message",
      id: generateMessageId(),
      role: "assistant",
      content: [
        { type: "output_text", text: accumulatedText, annotations: [] },
      ],
      status: "completed",
    } as ResponseOutputMessage);
  }

  for (const tc of toolCalls) {
    const info = toolMap?.get(tc.name);
    const name = info?.name ?? tc.name;
    if (info?.isCustom) {
      output.push({
        type: "custom_tool_call",
        id: generateCustomToolCallId(),
        call_id: tc.callId,
        name,
        input: customToolCallInput(tc.input),
        ...(info.namespace ? { namespace: info.namespace } : {}),
      } as ResponseCustomToolCall);
    } else {
      output.push({
        type: "function_call",
        id: generateFunctionCallId(),
        call_id: tc.callId,
        name,
        arguments: JSON.stringify(tc.input ?? {}),
        status: "completed",
        ...(info?.namespace ? { namespace: info.namespace } : {}),
      } as ResponseFunctionToolCall);
    }
  }

  return output;
};

/**
 * A `custom` tool's input is a raw string. We wrap it as `{ input: <string> }`
 * when replaying history into VSCode LM, so unwrap that shape on the way out;
 * fall back to JSON for anything else.
 */
export const customToolCallInput = (input: unknown): string => {
  if (typeof input === "string") {
    return input;
  }
  if (
    input &&
    typeof input === "object" &&
    typeof (input as { input?: unknown }).input === "string"
  ) {
    return (input as { input: string }).input;
  }
  return input === null || input === undefined ? "" : JSON.stringify(input);
};
