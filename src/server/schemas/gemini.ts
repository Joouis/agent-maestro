import {
  type Content,
  type GenerationConfig,
  type SafetySetting,
  type Tool,
  type ToolConfig,
  type GenerateContentResponse as _GenerateContentResponse,
} from "@google/genai";
import { z } from "@hono/zod-openapi";

export const GeminiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.number().describe("HTTP status code"),
      message: z.string().describe("Error message"),
      status: z.string().describe("Error status code (e.g., INVALID_ARGUMENT)"),
      log_file: z.string().optional().describe("Path to error log file"),
    }),
  })
  .openapi("GeminiErrorResponse");

export interface GenerateContentRequest {
  contents: Content[];
  tools?: Tool[];
  toolConfig?: ToolConfig;
  safetySettings?: SafetySetting[];
  systemInstruction?: Content;
  generationConfig?: GenerationConfig;
  cachedContent?: string;
}

/**
 * Extract data-only properties from GenerateContentResponse class
 * Omits methods like text, data, functionCalls, etc.
 */
export type GenerateContentResponse = Pick<
  _GenerateContentResponse,
  | "candidates"
  | "promptFeedback"
  | "usageMetadata"
  | "modelVersion"
  | "responseId"
>;
