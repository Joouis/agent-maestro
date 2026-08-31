import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";

import {
  MAX_WEB_SEARCH_RESULTS,
  WEB_SEARCH_PROVIDER_TIMEOUT_MS,
  WebSearchProvider,
  WebSearchResult,
  formatWebSearchEvidence,
  isPlainWebSearchHostname,
  normalizeWebSearchCountryCode,
  normalizeWebSearchResults,
  normalizeWebSearchUrl,
  runWebSearchProviderWithTimeout,
  validateWebSearchQueryInput,
} from "../webSearch/webSearchProvider";
import { AnthropicTokenUsage, extractAnthropicUsage } from "./anthropic";
import { isResponseTooLongError } from "./languageModelErrors";
import {
  LanguageModelRequestLifecycle,
  interruptibleLanguageModelStream,
} from "./languageModelRequestLifecycle";

const INTERNAL_WEB_SEARCH_TOOL_BASE =
  "__agent_maestro_internal_web_search_20250305";

type RawTool = Record<string, unknown>;
type RawToolChoice = Record<string, unknown>;

export interface AnthropicWebSearchConfiguration {
  maxUses: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    country: string;
  };
}

export interface PreparedAnthropicTools {
  internalWebSearchToolName?: string;
  tools?: vscode.LanguageModelChatTool[];
  toolMode?: vscode.LanguageModelChatToolMode;
  usesWebSearchLoop: boolean;
  webSearch?: AnthropicWebSearchConfiguration;
}

export class AnthropicRequestValidationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "ambiguous_tool_choice"
      | "invalid_tool_choice"
      | "invalid_tool_definition"
      | "tool_not_found"
      | "tool_unavailable",
  ) {
    super(message);
    this.name = "AnthropicRequestValidationError";
  }
}

const invalidToolDefinition = (message: string): never => {
  throw new AnthropicRequestValidationError(message, "invalid_tool_definition");
};

const asNullable = (value: unknown): unknown =>
  value === null ? undefined : value;

const validateDomains = (
  value: unknown,
  field: string,
): string[] | undefined => {
  value = asNullable(value);
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return invalidToolDefinition(`${field} must be an array`);
  }

  const domains = value.map((domain) => {
    if (typeof domain !== "string" || !isPlainWebSearchHostname(domain)) {
      return invalidToolDefinition(
        `${field} entries must be plain hostnames without paths`,
      );
    }
    return domain.toLowerCase();
  });
  return [...new Set(domains)];
};

const validateWebSearchTool = (
  tool: RawTool,
): AnthropicWebSearchConfiguration => {
  const supportedFields = new Set([
    "type",
    "name",
    "max_uses",
    "allowed_domains",
    "blocked_domains",
    "user_location",
    "cache_control",
    "strict",
    "allowed_callers",
    "defer_loading",
  ]);
  const unsupportedField = Object.keys(tool).find(
    (field) => !supportedFields.has(field),
  );
  if (unsupportedField) {
    return invalidToolDefinition(
      `Unsupported web search option: ${unsupportedField}`,
    );
  }
  if (tool.name !== "web_search") {
    return invalidToolDefinition(
      "web_search_20250305 must use the name 'web_search'",
    );
  }

  const maxUsesValue = asNullable(tool.max_uses);
  if (
    maxUsesValue !== undefined &&
    (typeof maxUsesValue !== "number" ||
      !Number.isInteger(maxUsesValue) ||
      maxUsesValue <= 0)
  ) {
    return invalidToolDefinition("max_uses must be a positive integer");
  }
  const allowedDomains = validateDomains(
    tool.allowed_domains,
    "allowed_domains",
  );
  const blockedDomains = validateDomains(
    tool.blocked_domains,
    "blocked_domains",
  );
  if (allowedDomains && blockedDomains) {
    return invalidToolDefinition(
      "allowed_domains and blocked_domains are mutually exclusive",
    );
  }

  const userLocationValue = asNullable(tool.user_location);
  let userLocation: { country: string } | undefined;
  if (userLocationValue !== undefined) {
    if (
      !userLocationValue ||
      typeof userLocationValue !== "object" ||
      Array.isArray(userLocationValue)
    ) {
      return invalidToolDefinition("user_location must be an object");
    }
    const location = userLocationValue as Record<string, unknown>;
    const locationFields = Object.keys(location);
    if (
      locationFields.some((field) => field !== "type" && field !== "country")
    ) {
      return invalidToolDefinition(
        "user_location supports only type and country",
      );
    }
    const country =
      typeof location.country === "string"
        ? normalizeWebSearchCountryCode(location.country)
        : undefined;
    if (
      location.type !== "approximate" ||
      typeof location.country !== "string" ||
      !country
    ) {
      return invalidToolDefinition(
        "user_location requires type 'approximate' and a two-letter country code",
      );
    }
    userLocation = { country };
  }

  const strict = asNullable(tool.strict);
  if (strict !== undefined && typeof strict !== "boolean") {
    return invalidToolDefinition("strict must be a boolean");
  }
  const allowedCallers = asNullable(tool.allowed_callers);
  if (
    allowedCallers !== undefined &&
    (!Array.isArray(allowedCallers) ||
      allowedCallers.some((caller) => caller !== "direct"))
  ) {
    return invalidToolDefinition(
      "allowed_callers supports only direct callers",
    );
  }
  const deferLoading = asNullable(tool.defer_loading);
  if (deferLoading !== undefined && deferLoading !== false) {
    return invalidToolDefinition("defer_loading must be false when provided");
  }

  return {
    maxUses: Math.min((maxUsesValue as number | undefined) ?? 1, 1),
    ...(allowedDomains && { allowedDomains }),
    ...(blockedDomains && { blockedDomains }),
    ...(userLocation && { userLocation }),
  };
};

const isImmediateToolResultContinuation = (messages: unknown): boolean => {
  if (!Array.isArray(messages)) {
    return false;
  }
  const latest = messages.at(-1);
  if (
    !latest ||
    typeof latest !== "object" ||
    (latest as Record<string, unknown>).role !== "user"
  ) {
    return false;
  }
  const content = (latest as Record<string, unknown>).content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "tool_result",
    )
  );
};

const validateDisableParallelToolUse = (toolChoice: unknown): void => {
  if (
    !toolChoice ||
    typeof toolChoice !== "object" ||
    Array.isArray(toolChoice)
  ) {
    return;
  }

  const rawChoice = toolChoice as RawToolChoice;
  const hasDisableParallel = Object.prototype.hasOwnProperty.call(
    rawChoice,
    "disable_parallel_tool_use",
  );
  if (rawChoice.type === "none" && hasDisableParallel) {
    throw new AnthropicRequestValidationError(
      "disable_parallel_tool_use must be omitted for tool_choice 'none'",
      "invalid_tool_choice",
    );
  }
  if (
    rawChoice.type !== "none" &&
    rawChoice.disable_parallel_tool_use !== undefined &&
    rawChoice.disable_parallel_tool_use !== null &&
    rawChoice.disable_parallel_tool_use !== false
  ) {
    throw new AnthropicRequestValidationError(
      "disable_parallel_tool_use is not supported",
      "invalid_tool_choice",
    );
  }
};

export function prepareAnthropicTools({
  tools,
  toolChoice,
  messages,
  serverWebSearchAvailable,
}: {
  tools?: unknown;
  toolChoice?: unknown;
  messages?: unknown;
  serverWebSearchAvailable: boolean;
}): PreparedAnthropicTools {
  const clientTools: Array<{
    name: string;
    tool: vscode.LanguageModelChatTool;
  }> = [];
  let webSearch:
    | { name: string; configuration: AnthropicWebSearchConfiguration }
    | undefined;

  if (tools !== undefined && !Array.isArray(tools)) {
    invalidToolDefinition("tools must be an array");
  }
  for (const value of (tools as unknown[] | undefined) ?? []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      invalidToolDefinition("tool declarations must be objects");
    }
    const tool = value as RawTool;
    if (tool.input_schema !== undefined) {
      if (typeof tool.name !== "string" || !tool.name) {
        invalidToolDefinition("client tools require a name");
      }
      if (
        !tool.input_schema ||
        typeof tool.input_schema !== "object" ||
        Array.isArray(tool.input_schema)
      ) {
        invalidToolDefinition("client tool input_schema must be an object");
      }
      clientTools.push({
        name: tool.name as string,
        tool: {
          name: tool.name as string,
          description:
            typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.input_schema as object,
        },
      });
      continue;
    }

    if (tool.type === "web_search_20250305") {
      if (webSearch) {
        invalidToolDefinition(
          "Only one web_search_20250305 declaration is supported",
        );
      }
      webSearch = {
        name: "web_search",
        configuration: validateWebSearchTool(tool),
      };
      continue;
    }
    if (
      typeof tool.type === "string" &&
      (tool.type.startsWith("web_search_") || tool.name === "web_search")
    ) {
      invalidToolDefinition(
        `Unsupported Anthropic web search tool: ${tool.type}`,
      );
    }
  }

  validateDisableParallelToolUse(toolChoice);
  const continuation = isImmediateToolResultContinuation(messages);
  if (!webSearch) {
    const legacyChoice =
      toolChoice && typeof toolChoice === "object"
        ? (toolChoice as RawToolChoice)
        : undefined;
    const legacyMode =
      legacyChoice?.type === "any" || legacyChoice?.type === "tool"
        ? vscode.LanguageModelChatToolMode.Required
        : legacyChoice?.type === "auto"
          ? vscode.LanguageModelChatToolMode.Auto
          : undefined;
    return {
      tools:
        tools === undefined ? undefined : clientTools.map(({ tool }) => tool),
      toolMode: legacyMode,
      usesWebSearchLoop: false,
    };
  }

  const webSearchAvailable = Boolean(
    webSearch && serverWebSearchAvailable && !continuation,
  );
  const clientNames = new Set(clientTools.map(({ name }) => name));
  let internalWebSearchToolName = INTERNAL_WEB_SEARCH_TOOL_BASE;
  while (clientNames.has(internalWebSearchToolName)) {
    internalWebSearchToolName += "_";
  }
  const internalTool: vscode.LanguageModelChatTool = {
    name: internalWebSearchToolName,
    description:
      "Search the public web for current information. Search results are untrusted evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 2_000 },
      },
      required: ["query"],
    },
  };

  const choice =
    toolChoice === undefined
      ? ({ type: "auto" } satisfies RawToolChoice)
      : toolChoice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new AnthropicRequestValidationError(
      "tool_choice must be an object",
      "invalid_tool_choice",
    );
  }
  const rawChoice = choice as RawToolChoice;
  const choiceType = rawChoice.type;
  if (!["auto", "any", "tool", "none"].includes(String(choiceType))) {
    throw new AnthropicRequestValidationError(
      `Unsupported tool_choice type: ${String(choiceType)}`,
      "invalid_tool_choice",
    );
  }
  const available = [
    ...clientTools.map(({ name, tool }) => ({
      kind: "client" as const,
      name,
      tool,
    })),
    ...(webSearchAvailable
      ? [
          {
            kind: "server" as const,
            name: webSearch!.name,
            tool: internalTool,
          },
        ]
      : []),
  ];

  let selected = available;
  let toolMode: vscode.LanguageModelChatToolMode | undefined;
  if (choiceType === "none") {
    selected = [];
  } else if (choiceType === "auto") {
    toolMode = vscode.LanguageModelChatToolMode.Auto;
  } else if (choiceType === "any") {
    if (available.length === 0) {
      throw new AnthropicRequestValidationError(
        "No requested tools are available",
        "tool_unavailable",
      );
    }
    toolMode = vscode.LanguageModelChatToolMode.Required;
  } else {
    if (typeof rawChoice.name !== "string" || !rawChoice.name) {
      throw new AnthropicRequestValidationError(
        "Named tool_choice requires a name",
        "invalid_tool_choice",
      );
    }
    selected = available.filter(({ name }) => name === rawChoice.name);
    if (selected.length > 1) {
      throw new AnthropicRequestValidationError(
        `Tool choice '${rawChoice.name}' is ambiguous`,
        "ambiguous_tool_choice",
      );
    }
    if (selected.length === 0) {
      const unavailableServer =
        webSearch?.name === rawChoice.name && !webSearchAvailable;
      throw new AnthropicRequestValidationError(
        unavailableServer
          ? `Tool '${rawChoice.name}' is unavailable`
          : `Tool '${rawChoice.name}' was not found`,
        unavailableServer ? "tool_unavailable" : "tool_not_found",
      );
    }
    toolMode = vscode.LanguageModelChatToolMode.Required;
  }

  const selectedServer = selected.some(({ kind }) => kind === "server");
  return {
    tools: selected.length > 0 ? selected.map(({ tool }) => tool) : undefined,
    toolMode,
    usesWebSearchLoop: selectedServer,
    ...(selectedServer && {
      internalWebSearchToolName,
      webSearch: webSearch!.configuration,
    }),
  };
}

interface CollectedModelRound {
  blocks: Anthropic.Messages.ContentBlock[];
  parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart>;
  stopReason: Anthropic.Messages.StopReason;
  usage: AnthropicTokenUsage;
}

export interface AnthropicSearchLoopResult {
  content: Anthropic.Messages.ContentBlock[];
  stopReason: Anthropic.Messages.StopReason;
  usage: AnthropicTokenUsage;
  webSearchRequests: number;
}

const emptyUsage = (): AnthropicTokenUsage => ({
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
});

const addUsage = (
  left: AnthropicTokenUsage,
  right: AnthropicTokenUsage,
): AnthropicTokenUsage => ({
  cache_creation_input_tokens:
    left.cache_creation_input_tokens + right.cache_creation_input_tokens,
  cache_read_input_tokens:
    left.cache_read_input_tokens + right.cache_read_input_tokens,
  input_tokens: left.input_tokens + right.input_tokens,
  output_tokens: left.output_tokens + right.output_tokens,
});

const collectModelRound = async ({
  client,
  messages,
  requestOptions,
  lifecycle,
}: {
  client: vscode.LanguageModelChat;
  messages: vscode.LanguageModelChatMessage[];
  requestOptions: vscode.LanguageModelChatRequestOptions;
  lifecycle: LanguageModelRequestLifecycle;
}): Promise<CollectedModelRound> => {
  const response = await lifecycle.waitFor(
    client.sendRequest(messages, requestOptions, lifecycle.token),
  );
  const blocks: Anthropic.Messages.ContentBlock[] = [];
  const parts: Array<
    vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
  > = [];
  let responseUsage: AnthropicTokenUsage | undefined;
  let stopReason: Anthropic.Messages.StopReason = "end_turn";

  try {
    for await (const chunk of interruptibleLanguageModelStream(
      response.stream,
      lifecycle,
    )) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        const lastBlock = blocks.at(-1);
        if (lastBlock?.type === "text") {
          lastBlock.text += chunk.value;
          const lastPart = parts.at(-1);
          if (lastPart instanceof vscode.LanguageModelTextPart) {
            lastPart.value += chunk.value;
          } else {
            parts.push(new vscode.LanguageModelTextPart(chunk.value));
          }
        } else {
          blocks.push({ type: "text", text: chunk.value, citations: null });
          parts.push(new vscode.LanguageModelTextPart(chunk.value));
        }
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        blocks.push({
          type: "tool_use",
          id: chunk.callId,
          caller: { type: "direct" },
          name: chunk.name,
          input: chunk.input,
        });
        parts.push(chunk);
      } else if (chunk instanceof vscode.LanguageModelDataPart) {
        responseUsage = extractAnthropicUsage(chunk) ?? responseUsage;
      }
    }
  } catch (error) {
    if (!isResponseTooLongError(error)) {
      throw error;
    }
    stopReason = "max_tokens";
  }

  const fallbackOutput = JSON.stringify(blocks);
  const usage =
    responseUsage ??
    ({
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: await lifecycle.waitFor(
        client.countTokens(JSON.stringify(messages), lifecycle.token),
      ),
      output_tokens: fallbackOutput
        ? await lifecycle.waitFor(
            client.countTokens(fallbackOutput, lifecycle.token),
          )
        : 1,
    } satisfies AnthropicTokenUsage);

  if (stopReason !== "max_tokens" && blocks.at(-1)?.type === "tool_use") {
    stopReason = "tool_use";
  }
  return { blocks, parts, stopReason, usage };
};

const appendSourcesWithinBudget = async ({
  content,
  results,
  usage,
  maxTokens,
  client,
  lifecycle,
}: {
  content: Anthropic.Messages.ContentBlock[];
  results: readonly WebSearchResult[];
  usage: AnthropicTokenUsage;
  maxTokens: number;
  client: vscode.LanguageModelChat;
  lifecycle: LanguageModelRequestLifecycle;
}): Promise<{
  usage: AnthropicTokenUsage;
  exhausted: boolean;
}> => {
  const visibleText = content
    .filter(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
  const citedUrls = new Set(
    (visibleText.match(/https?:\/\/[^\s<>()\[\]{}"']+/g) ?? [])
      .map((url) => url.replace(/[.,;:!?]+$/, ""))
      .map(normalizeWebSearchUrl)
      .filter((url): url is string => url !== undefined),
  );
  const missingUrls = results
    .map(({ url }) => url)
    .filter((url) => !citedUrls.has(url));
  if (missingUrls.length === 0) {
    return { usage, exhausted: false };
  }

  let addition = "";
  let outputTokens = usage.output_tokens;
  let exhausted = false;
  for (const url of missingUrls) {
    const entry = `${addition ? "\n" : "\n\nSources:\n"}- ${url}`;
    const entryTokens = await lifecycle.waitFor(
      client.countTokens(entry, lifecycle.token),
    );
    if (outputTokens + entryTokens > maxTokens) {
      exhausted = true;
      break;
    }
    addition += entry;
    outputTokens += entryTokens;
  }

  if (addition) {
    const lastText = [...content]
      .reverse()
      .find(
        (block): block is Anthropic.Messages.TextBlock => block.type === "text",
      );
    if (lastText) {
      lastText.text += addition;
    } else {
      content.push({
        type: "text",
        text: addition.trimStart(),
        citations: null,
      });
    }
  }
  return {
    usage: { ...usage, output_tokens: outputTokens },
    exhausted,
  };
};

export async function runAnthropicWebSearchLoop({
  client,
  messages,
  baseRequestOptions,
  preparedTools,
  provider,
  lifecycle,
  maxTokens,
  providerTimeoutMs = WEB_SEARCH_PROVIDER_TIMEOUT_MS,
}: {
  client: vscode.LanguageModelChat;
  messages: vscode.LanguageModelChatMessage[];
  baseRequestOptions: vscode.LanguageModelChatRequestOptions;
  preparedTools: PreparedAnthropicTools;
  provider: WebSearchProvider;
  lifecycle: LanguageModelRequestLifecycle;
  maxTokens: number;
  providerTimeoutMs?: number;
}): Promise<AnthropicSearchLoopResult> {
  if (
    !preparedTools.usesWebSearchLoop ||
    !preparedTools.internalWebSearchToolName ||
    !preparedTools.webSearch
  ) {
    throw new Error("Web search loop requires a prepared server search tool");
  }

  const firstRound = await collectModelRound({
    client,
    messages,
    lifecycle,
    requestOptions: {
      ...baseRequestOptions,
      modelOptions: {
        ...baseRequestOptions.modelOptions,
        max_tokens: maxTokens,
      },
      tools: preparedTools.tools,
      toolMode: preparedTools.toolMode,
    },
  });
  const internalCalls = firstRound.parts.filter(
    (part): part is vscode.LanguageModelToolCallPart =>
      part instanceof vscode.LanguageModelToolCallPart &&
      part.name === preparedTools.internalWebSearchToolName,
  );
  const clientCalls = firstRound.parts.filter(
    (part): part is vscode.LanguageModelToolCallPart =>
      part instanceof vscode.LanguageModelToolCallPart &&
      part.name !== preparedTools.internalWebSearchToolName,
  );
  const visibleFirstRound = firstRound.blocks.filter(
    (block) =>
      block.type !== "tool_use" ||
      block.name !== preparedTools.internalWebSearchToolName,
  );

  if (internalCalls.length === 0) {
    return {
      content: visibleFirstRound,
      stopReason: firstRound.stopReason,
      usage: firstRound.usage,
      webSearchRequests: 0,
    };
  }
  if (clientCalls.length > 0) {
    return {
      content: visibleFirstRound,
      stopReason: "tool_use",
      usage: firstRound.usage,
      webSearchRequests: 0,
    };
  }
  if (
    firstRound.stopReason === "max_tokens" ||
    firstRound.usage.output_tokens >= maxTokens
  ) {
    return {
      content: visibleFirstRound,
      stopReason: "max_tokens",
      usage: {
        ...firstRound.usage,
        output_tokens: Math.min(firstRound.usage.output_tokens, maxTokens),
      },
      webSearchRequests: 0,
    };
  }

  const toolResults: vscode.LanguageModelToolResultPart[] = [];
  let normalizedResults: WebSearchResult[] = [];
  let webSearchRequests = 0;
  const firstCall = internalCalls[0];
  const query = validateWebSearchQueryInput(firstCall.input);
  if (!query) {
    toolResults.push(
      new vscode.LanguageModelToolResultPart(firstCall.callId, [
        new vscode.LanguageModelTextPart(
          "Web search error: invalid_tool_input",
        ),
      ]),
    );
  } else {
    webSearchRequests = 1;
    try {
      normalizedResults = normalizeWebSearchResults(
        await lifecycle.waitFor(
          runWebSearchProviderWithTimeout(
            provider,
            {
              query,
              maxResults: MAX_WEB_SEARCH_RESULTS,
              ...(preparedTools.webSearch.allowedDomains && {
                allowedDomains: preparedTools.webSearch.allowedDomains,
              }),
              ...(preparedTools.webSearch.blockedDomains && {
                blockedDomains: preparedTools.webSearch.blockedDomains,
              }),
              ...(preparedTools.webSearch.userLocation && {
                userLocation: preparedTools.webSearch.userLocation,
              }),
            },
            lifecycle.signal,
            providerTimeoutMs,
          ),
        ),
      );
      toolResults.push(
        new vscode.LanguageModelToolResultPart(firstCall.callId, [
          new vscode.LanguageModelTextPart(
            formatWebSearchEvidence(normalizedResults),
          ),
        ]),
      );
    } catch {
      if (lifecycle.signal.aborted) {
        const reason = lifecycle.signal.reason;
        throw reason instanceof Error
          ? reason
          : new Error("Web search request was cancelled");
      }
      toolResults.push(
        new vscode.LanguageModelToolResultPart(firstCall.callId, [
          new vscode.LanguageModelTextPart(
            "Web search error: provider_request_failed. Explain that web search was unavailable without claiming current results.",
          ),
        ]),
      );
    }
  }
  for (const call of internalCalls.slice(1)) {
    toolResults.push(
      new vscode.LanguageModelToolResultPart(call.callId, [
        new vscode.LanguageModelTextPart("Web search error: max_uses_exceeded"),
      ]),
    );
  }

  const remainingTokens = maxTokens - firstRound.usage.output_tokens;
  const hiddenMessages = [
    ...messages,
    vscode.LanguageModelChatMessage.Assistant(firstRound.parts),
    vscode.LanguageModelChatMessage.User(toolResults),
  ];
  const synthesisRound = await collectModelRound({
    client,
    messages: hiddenMessages,
    lifecycle,
    requestOptions: {
      ...baseRequestOptions,
      modelOptions: {
        ...baseRequestOptions.modelOptions,
        max_tokens: remainingTokens,
      },
      tools: undefined,
      toolMode: undefined,
    },
  });
  const synthesisText = synthesisRound.blocks.filter(
    (block) => block.type === "text",
  );
  const content = [...visibleFirstRound, ...synthesisText];
  let usage = addUsage(firstRound.usage, synthesisRound.usage);
  let stopReason: Anthropic.Messages.StopReason =
    synthesisRound.stopReason === "max_tokens" ||
    usage.output_tokens >= maxTokens
      ? "max_tokens"
      : "end_turn";
  if (usage.output_tokens > maxTokens) {
    usage = { ...usage, output_tokens: maxTokens };
  }

  if (stopReason === "end_turn" && normalizedResults.length > 0) {
    const sourceResult = await appendSourcesWithinBudget({
      content,
      results: normalizedResults,
      usage,
      maxTokens,
      client,
      lifecycle,
    });
    usage = sourceResult.usage;
    if (sourceResult.exhausted) {
      stopReason = "max_tokens";
    }
  }

  return { content, stopReason, usage, webSearchRequests };
}

export { isImmediateToolResultContinuation };
