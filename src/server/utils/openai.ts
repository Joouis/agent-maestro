import OpenAI from "openai";
import { ResponseUsage } from "openai/resources/responses/responses";

interface CopilotUsagePayload {
  completion_tokens: number;
  completion_tokens_details?: {
    accepted_prediction_tokens?: number;
    reasoning_tokens?: number;
    rejected_prediction_tokens?: number;
  };
  prompt_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  total_tokens?: number;
}

function isCopilotUsagePayload(value: unknown): value is CopilotUsagePayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const usage = value as Partial<CopilotUsagePayload>;
  return (
    typeof usage.prompt_tokens === "number" &&
    Number.isFinite(usage.prompt_tokens) &&
    usage.prompt_tokens >= 0 &&
    typeof usage.completion_tokens === "number" &&
    Number.isFinite(usage.completion_tokens) &&
    usage.completion_tokens >= 0
  );
}

const nonNegativeNumberOrZero = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

const nonNegativeNumberOrUndefined = (
  value: number | undefined,
): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const totalTokensOrFallback = (usage: CopilotUsagePayload): number =>
  nonNegativeNumberOrUndefined(usage.total_tokens) ??
  usage.prompt_tokens + usage.completion_tokens;

export function extractOpenAIChatTokenUsageFromVSCodeChunk(chunk: {
  data: Uint8Array;
  mimeType: string;
}): OpenAI.CompletionUsage | undefined {
  const usage = extractCopilotUsagePayload(chunk);
  if (!usage) {
    return undefined;
  }

  return {
    completion_tokens: usage.completion_tokens,
    completion_tokens_details: {
      accepted_prediction_tokens: nonNegativeNumberOrZero(
        usage.completion_tokens_details?.accepted_prediction_tokens,
      ),
      reasoning_tokens: nonNegativeNumberOrZero(
        usage.completion_tokens_details?.reasoning_tokens,
      ),
      rejected_prediction_tokens: nonNegativeNumberOrZero(
        usage.completion_tokens_details?.rejected_prediction_tokens,
      ),
    },
    prompt_tokens: usage.prompt_tokens,
    prompt_tokens_details: {
      cached_tokens: nonNegativeNumberOrZero(
        usage.prompt_tokens_details?.cached_tokens,
      ),
    },
    total_tokens: totalTokensOrFallback(usage),
  };
}

export function extractOpenAIResponsesTokenUsageFromVSCodeChunk(chunk: {
  data: Uint8Array;
  mimeType: string;
}): ResponseUsage | undefined {
  const usage = extractCopilotUsagePayload(chunk);
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.prompt_tokens,
    input_tokens_details: {
      cached_tokens: nonNegativeNumberOrZero(
        usage.prompt_tokens_details?.cached_tokens,
      ),
    },
    output_tokens: usage.completion_tokens,
    output_tokens_details: {
      reasoning_tokens: nonNegativeNumberOrZero(
        usage.completion_tokens_details?.reasoning_tokens,
      ),
    },
    total_tokens: totalTokensOrFallback(usage),
  };
}

function extractCopilotUsagePayload(chunk: {
  data: Uint8Array;
  mimeType: string;
}): CopilotUsagePayload | undefined {
  if (chunk.mimeType !== "usage") {
    return undefined;
  }

  try {
    const usage = JSON.parse(new TextDecoder().decode(chunk.data)) as unknown;
    return isCopilotUsagePayload(usage) ? usage : undefined;
  } catch {
    return undefined;
  }
}
