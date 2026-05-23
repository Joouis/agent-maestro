export interface CopilotUsagePayload {
  completion_tokens: number;
  completion_tokens_details?: {
    accepted_prediction_tokens?: number;
    reasoning_tokens?: number;
    rejected_prediction_tokens?: number;
  };
  prompt_tokens: number;
  prompt_tokens_details?: {
    cache_creation_input_tokens?: number;
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

export function extractCopilotUsagePayload(chunk: {
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
