import OpenAI from "openai";
import { ResponseUsage } from "openai/resources/responses/responses";

import {
  type CopilotUsagePayload,
  extractCopilotUsagePayload,
} from "./copilotUsage";

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

export function extractOpenAIChatUsage(chunk: {
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

export function extractOpenAIResponsesUsage(chunk: {
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
