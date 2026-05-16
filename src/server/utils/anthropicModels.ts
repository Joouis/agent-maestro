import {
  ModelCapabilities,
  ModelInfo,
} from "@anthropic-ai/sdk/resources/models";
import * as vscode from "vscode";

export interface AnthropicModelsResponse {
  data: ModelInfo[];
  first_id: string | null;
  has_more: boolean;
  last_id: string | null;
}

const UNKNOWN_MODEL_CREATED_AT = "1970-01-01T00:00:00Z";
const supported = { supported: true };
const unsupported = { supported: false };

interface VSCodeModelCapabilities {
  supportsImageToText?: boolean;
  supportsToolCalling?: boolean;
}

function getCapabilities(
  model: vscode.LanguageModelChat,
): VSCodeModelCapabilities {
  return (
    (model as { capabilities?: VSCodeModelCapabilities }).capabilities ?? {}
  );
}

function convertVSCodeCapabilitiesToAnthropic(
  model: vscode.LanguageModelChat,
): ModelCapabilities {
  const capabilities = getCapabilities(model);
  const supportsImageInput = capabilities.supportsImageToText === true;
  const supportsToolCalling = capabilities.supportsToolCalling === true;

  return {
    batch: unsupported,
    citations: unsupported,
    code_execution: unsupported,
    context_management: {
      clear_thinking_20251015: unsupported,
      clear_tool_uses_20250919: unsupported,
      compact_20260112: unsupported,
      supported: false,
    },
    effort: {
      high: unsupported,
      low: unsupported,
      max: unsupported,
      medium: unsupported,
      supported: false,
      xhigh: unsupported,
    },
    image_input: supportsImageInput ? supported : unsupported,
    pdf_input: unsupported,
    structured_outputs: supportsToolCalling ? supported : unsupported,
    thinking: {
      supported: false,
      types: {
        adaptive: unsupported,
        enabled: unsupported,
      },
    },
  };
}

function isClaudeModel(model: vscode.LanguageModelChat): boolean {
  const searchable = `${model.id} ${model.name} ${model.family}`.toLowerCase();
  return searchable.includes("claude");
}

export function convertVSCodeModelToAnthropicModel(
  model: vscode.LanguageModelChat,
): ModelInfo {
  return {
    id: model.id,
    capabilities: convertVSCodeCapabilitiesToAnthropic(model),
    created_at: UNKNOWN_MODEL_CREATED_AT,
    display_name: model.name,
    max_input_tokens: model.maxInputTokens,
    max_tokens: 0,
    type: "model",
  };
}

export function createAnthropicModelsResponse(
  models: vscode.LanguageModelChat[],
): AnthropicModelsResponse {
  const data = models
    .filter(isClaudeModel)
    .map(convertVSCodeModelToAnthropicModel);

  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  };
}
