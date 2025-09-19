import { z } from "@hono/zod-openapi";

const ReasoningEffort = z.enum(["low", "medium", "high"]);

const VoiceIdsShared = z.enum([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
]);

const ParallelToolCalls = z.boolean().default(true);

const StopConfiguration = z
  .union([z.string(), z.array(z.string()).max(4)])
  .nullable();

// Response format schemas
const ResponseFormatText = z.object({
  type: z.literal("text"),
});

const ResponseFormatJsonObject = z.object({
  type: z.literal("json_object"),
});

const ResponseFormatJsonSchemaSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.any()).optional(),
  strict: z.boolean().optional(),
});

const ResponseFormatJsonSchema = z.object({
  type: z.literal("json_schema"),
  json_schema: ResponseFormatJsonSchemaSchema,
});

const ResponseFormat = z.union([
  ResponseFormatText,
  ResponseFormatJsonObject,
  ResponseFormatJsonSchema,
]);

// Function and tool schemas
const FunctionObject = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.any()).optional(),
  strict: z.boolean().optional(),
});

const ChatCompletionTool = z.object({
  type: z.literal("function"),
  function: FunctionObject,
});

const ChatCompletionNamedToolChoice = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
  }),
});

const ChatCompletionToolChoiceOption = z.union([
  z.literal("none"),
  z.literal("auto"),
  z.literal("required"),
  ChatCompletionNamedToolChoice,
]);

const ChatCompletionFunctionCallOption = z.object({
  name: z.string(),
});

const ChatCompletionFunctions = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.any()).optional(),
});

// Content part schemas
const ChatCompletionRequestMessageContentPartText = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const ChatCompletionRequestMessageContentPartImage = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

const ChatCompletionRequestMessageContentPartAudio = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string(),
    format: z.enum(["wav", "mp3"]),
  }),
});

const ChatCompletionRequestMessageContentPart = z.union([
  ChatCompletionRequestMessageContentPartText,
  ChatCompletionRequestMessageContentPartImage,
  ChatCompletionRequestMessageContentPartAudio,
]);

// Message schemas
const ChatCompletionRequestMessage = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z
    .union([z.string(), z.array(ChatCompletionRequestMessageContentPart)])
    .optional(),
  name: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
  refusal: z.string().nullable().optional(),
  function_call: z
    .object({
      name: z.string(),
      arguments: z.string(),
    })
    .optional(),
});

// Stream options
const ChatCompletionStreamOptions = z.object({
  include_usage: z.boolean().optional(),
});

// Output prediction
const ChatOutputPrediction = z.object({
  type: z.literal("content"),
  content: z.union([
    z.string(),
    z.array(ChatCompletionRequestMessageContentPart),
  ]),
});

// Response modalities
const ResponseModalities = z.array(z.enum(["text", "audio"]));

/**
 * POST /chat/completions request body
 */
export const CreateChatCompletionRequest = z.looseObject({
  // Required properties
  messages: z.array(ChatCompletionRequestMessage).min(1),
  model: z.string(),

  // Optional metadata and basic parameters
  metadata: z.record(z.string(), z.string()).optional(),
  temperature: z.number().min(0).max(2).nullable().default(1).optional(),
  top_p: z.number().min(0).max(1).nullable().default(1).optional(),
  user: z.string().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),

  // Modalities and reasoning
  modalities: ResponseModalities.nullable().optional(),
  reasoning_effort: ReasoningEffort.nullable().default("medium").optional(),

  // Token limits and penalties
  max_completion_tokens: z.number().int().nullable().optional(),
  frequency_penalty: z.number().min(-2).max(2).nullable().default(0).optional(),
  presence_penalty: z.number().min(-2).max(2).nullable().default(0).optional(),

  // web_search_options not supported yet

  // Response format and audio
  response_format: ResponseFormat.optional(),
  audio: z
    .object({
      voice: VoiceIdsShared,
      format: z.enum(["wav", "aac", "mp3", "flac", "opus", "pcm16"]),
    })
    .nullable()
    .optional(),

  // Streaming and storage
  store: z.boolean().nullable().default(false).optional(),
  stream: z.boolean().nullable().default(false).optional(),
  stop: StopConfiguration.default(null).optional(),

  // Bias and probability settings
  logit_bias: z
    .record(z.string(), z.number().int())
    .nullable()
    .default(null)
    .optional(),
  logprobs: z.boolean().nullable().default(false).optional(),

  // Deprecated max_tokens
  max_tokens: z.number().int().nullable().optional(),

  // Generation settings
  n: z.number().int().min(1).max(128).nullable().default(1).optional(),
  prediction: ChatOutputPrediction.nullable().optional(),
  seed: z
    .number()
    .int()
    .min(-9223372036854776000)
    .max(9223372036854776000)
    .nullable()
    .optional(),
  stream_options: ChatCompletionStreamOptions.nullable()
    .default(null)
    .optional(),

  // Tools and functions
  tools: z.array(ChatCompletionTool).optional(),
  tool_choice: ChatCompletionToolChoiceOption.optional(),
  parallel_tool_calls: ParallelToolCalls.default(true).optional(),

  // Deprecated function calling
  function_call: z
    .union([z.enum(["none", "auto"]), ChatCompletionFunctionCallOption])
    .optional(),
  functions: z.array(ChatCompletionFunctions).min(1).max(128).optional(),
});

// Completion usage with detailed token breakdown
const CompletionTokensDetails = z.object({
  accepted_prediction_tokens: z.number().int().default(0).optional(),
  audio_tokens: z.number().int().default(0).optional(),
  reasoning_tokens: z.number().int().default(0).optional(),
  rejected_prediction_tokens: z.number().int().default(0).optional(),
});

const PromptTokensDetails = z.object({
  audio_tokens: z.number().int().default(0).optional(),
  cached_tokens: z.number().int().default(0).optional(),
});

const CompletionUsage = z.object({
  completion_tokens: z.number().int().default(0),
  prompt_tokens: z.number().int().default(0),
  total_tokens: z.number().int().default(0),
  completion_tokens_details: CompletionTokensDetails.optional(),
  prompt_tokens_details: PromptTokensDetails.optional(),
});

// Chat completion token logprob
const ChatCompletionTokenLogprobTopLogprob = z.object({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int()).nullable().optional(),
});

const ChatCompletionTokenLogprob = z.object({
  token: z.string(),
  logprob: z.number(),
  bytes: z.array(z.number().int()).nullable().optional(),
  top_logprobs: z.array(ChatCompletionTokenLogprobTopLogprob).optional(),
});

// Chat completion message tool call
const ChatCompletionMessageToolCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

// Chat completion response message
const ChatCompletionResponseMessage = z.object({
  content: z.string().nullable().optional(),
  refusal: z.string().nullable().optional(),
  role: z.literal("assistant"),
  tool_calls: z.array(ChatCompletionMessageToolCall).optional(),
  function_call: z
    .object({
      name: z.string(),
      arguments: z.string(),
    })
    .optional(),
  audio: z
    .object({
      id: z.string(),
      expires_at: z.number().int(),
      data: z.string(),
      transcript: z.string(),
    })
    .nullable()
    .optional(),
});

// Choice schema for chat completion response
const ChatCompletionChoice = z.object({
  finish_reason: z.enum([
    "stop",
    "length",
    "tool_calls",
    "content_filter",
    "function_call",
  ]),
  index: z.number().int(),
  message: ChatCompletionResponseMessage,
  logprobs: z
    .object({
      content: z.array(ChatCompletionTokenLogprob).nullable(),
      refusal: z.array(ChatCompletionTokenLogprob).nullable(),
    })
    .nullable(),
});

/**
 * POST /chat/completions application/json response
 */
export const CreateChatCompletionResponse = z.object({
  id: z.string(),
  choices: z.array(ChatCompletionChoice),
  created: z.number().int(),
  model: z.string(),
  service_tier: z.enum(["scale", "default"]).nullable().optional(),
  system_fingerprint: z.string().optional(),
  object: z.literal("chat.completion"),
  usage: CompletionUsage.optional(),
});

// Chat completion response role
const ChatCompletionResponse = z.enum([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
  "function",
]);

// Chat completion message audio chunk for streaming
const ChatCompletionMessageAudioChunk = z.object({
  id: z.string().optional(),
  transcript: z.string().optional(),
  data: z.string().optional(), // base64 format
  expires_at: z.number().int().optional(),
});

// Chat completion message tool call chunk for streaming
const ChatCompletionMessageToolCallChunk = z.object({
  index: z.number().int(),
  id: z.string().optional(),
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

// OpenAI chat completion stream response delta
const ChatCompletionStreamResponseDelta = z.object({
  audio: ChatCompletionMessageAudioChunk.optional(),
  content: z.string().nullable().optional(),
  function_call: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
  tool_calls: z.array(ChatCompletionMessageToolCallChunk).optional(),
  role: ChatCompletionResponse.optional(),
  refusal: z.string().nullable().optional(),
});

const CreateChatCompletionStreamChoice = z.object({
  delta: ChatCompletionStreamResponseDelta,
  logprobs: z
    .object({
      content: z.array(ChatCompletionTokenLogprob).nullable(),
      refusal: z.array(ChatCompletionTokenLogprob).nullable(),
    })
    .nullable(),
  finish_reason: z
    .enum(["stop", "length", "tool_calls", "content_filter", "function_call"])
    .nullable(),
  index: z.number().int(),
});

/**
 * POST /chat/completions text/event-stream response
 */
export const CreateChatCompletionStreamResponse = z.object({
  id: z.string(),
  choices: z.array(CreateChatCompletionStreamChoice),
  created: z.number().int(),
  model: z.string(),
  service_tier: z.enum(["scale", "default"]).nullable().optional(),
  system_fingerprint: z.string().optional(),
  object: z.literal("chat.completion.chunk"),
  usage: CompletionUsage.nullable().optional(), // Only present on final chunk
});

// Response error schemas
const ResponseErrorCode = z.enum([
  "server_error",
  "rate_limit_exceeded",
  "invalid_prompt",
  "vector_store_timeout",
  "invalid_image",
  "invalid_image_format",
  "invalid_base64_image",
  "invalid_image_url",
  "image_too_large",
  "image_too_small",
  "image_parse_error",
  "image_content_policy_violation",
  "invalid_image_mode",
  "image_file_too_large",
  "unsupported_image_media_type",
  "empty_image_file",
  "failed_to_download_image",
  "image_file_not_found",
]);

const ResponseError = z.object({
  code: ResponseErrorCode,
  message: z.string(),
});

// Response usage schemas
const ResponseUsage = z.object({
  input_tokens: z.number().int(),
  input_tokens_details: z.object({
    cached_tokens: z.number().int(),
  }),
  output_tokens: z.number().int(),
  output_tokens_details: z.object({
    reasoning_tokens: z.number().int(),
  }),
  total_tokens: z.number().int(),
});

// Item type enum
const ItemTypeEnum = z.enum([
  "message",
  "file_search_call",
  "function_call",
  "function_call_output",
  "computer_call",
  "computer_call_output",
  "web_search_call",
  "reasoning",
  "item_reference",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "local_shell_call_output",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "mcp_call",
]);

// Item resource schema (simplified - full discriminated union would be extensive)
const ItemResource = z.object({
  type: ItemTypeEnum,
  id: z.string(),
});

// Updated Reasoning schema to match OpenAI.Reasoning
const Reasoning = z.object({
  effort: ReasoningEffort.nullable().default("medium").optional(),
  summary: z.enum(["auto", "concise", "detailed"]).nullable().optional(),
  generate_summary: z
    .enum(["auto", "concise", "detailed"])
    .nullable()
    .default(null)
    .optional(),
});

// Response text format configuration
const ResponseTextFormatConfigurationType = z.enum([
  "text",
  "json_schema",
  "json_object",
]);

const ResponseTextFormatConfiguration = z.object({
  type: ResponseTextFormatConfigurationType,
});

// Tool choice options (enum)
const ToolChoiceOptions = z.enum(["none", "auto", "required"]);

// Enhanced tool system
const ToolType = z.enum([
  "function",
  "file_search",
  "code_interpreter",
  "computer_use_preview",
  "web_search_preview",
  "image_gen",
  "local_shell",
  "mcp",
]);

// Function tool (enhanced version)
const FunctionTool = z.object({
  type: z.literal("function"),
  function: FunctionObject,
});

// File search tool
const FileSearchTool = z.object({
  type: z.literal("file_search"),
  file_search: z
    .object({
      max_num_results: z.number().int().min(1).max(50).optional(),
      ranking_options: z
        .object({
          ranker: z.enum(["auto", "default_2024_08_21"]).optional(),
          score_threshold: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

// Code interpreter tool
const CodeInterpreterTool = z.object({
  type: z.literal("code_interpreter"),
  code_interpreter: z
    .object({
      outputs: z
        .array(
          z.object({
            type: z.enum(["image", "logs"]),
            image: z
              .object({
                file_id: z.string(),
              })
              .optional(),
            logs: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

// Web search tool
const WebSearchPreviewTool = z.object({
  type: z.literal("web_search_preview"),
  web_search_preview: z
    .object({
      max_results: z.number().int().min(1).max(20).optional(),
    })
    .optional(),
});

// Image generation tool
const ImageGenTool = z.object({
  type: z.literal("image_gen"),
  image_gen: z
    .object({
      model: z.enum(["dall-e-2", "dall-e-3"]).optional(),
      quality: z.enum(["standard", "hd"]).optional(),
      size: z
        .enum(["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"])
        .optional(),
      style: z.enum(["vivid", "natural"]).optional(),
    })
    .optional(),
});

// Computer use tool
const ComputerUsePreviewTool = z.object({
  type: z.literal("computer_use_preview"),
  computer_use_preview: z
    .object({
      display_width_px: z.number().int().optional(),
      display_height_px: z.number().int().optional(),
      display_number: z.number().int().optional(),
    })
    .optional(),
});

// Local shell tool
const LocalShellTool = z.object({
  type: z.literal("local_shell"),
  local_shell: z
    .object({
      allowed_commands: z.array(z.string()).optional(),
      working_directory: z.string().optional(),
    })
    .optional(),
});

// MCP tool
const MCPTool = z.object({
  type: z.literal("mcp"),
  mcp: z.object({
    server_name: z.string(),
    tool_name: z.string().optional(),
  }),
});

// Union of all tools
const Tool = z.union([
  FunctionTool,
  FileSearchTool,
  CodeInterpreterTool,
  WebSearchPreviewTool,
  ImageGenTool,
  ComputerUsePreviewTool,
  LocalShellTool,
  MCPTool,
]);

// Tool choice object types
const ToolChoiceObjectFunction = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
  }),
});

const ToolChoiceObjectFileSearch = z.object({
  type: z.literal("file_search"),
});

const ToolChoiceObjectCodeInterpreter = z.object({
  type: z.literal("code_interpreter"),
});

const ToolChoiceObjectWebSearch = z.object({
  type: z.literal("web_search_preview"),
});

const ToolChoiceObjectImageGen = z.object({
  type: z.literal("image_gen"),
});

const ToolChoiceObjectComputer = z.object({
  type: z.literal("computer_use_preview"),
});

const ToolChoiceObjectLocalShell = z.object({
  type: z.literal("local_shell"),
});

const ToolChoiceObjectMCP = z.object({
  type: z.literal("mcp"),
  mcp: z.object({
    server_name: z.string(),
    tool_name: z.string().optional(),
  }),
});

// Union of all tool choice objects
const ToolChoiceObject = z.union([
  ToolChoiceObjectFunction,
  ToolChoiceObjectFileSearch,
  ToolChoiceObjectCodeInterpreter,
  ToolChoiceObjectWebSearch,
  ToolChoiceObjectImageGen,
  ToolChoiceObjectComputer,
  ToolChoiceObjectLocalShell,
  ToolChoiceObjectMCP,
]);

// Prompt schema
const Prompt = z.object({
  id: z.string().optional(),
  template: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

// Includable options
const Includable = z.enum([
  "code_interpreter_call.outputs",
  "computer_call_output.output.image_url",
  "file_search_call.results",
  "message.input_image.image_url",
  "message.output_text.logprobs",
  "reasoning.encrypted_content",
]);

// Basic content types for ItemParam
const ItemContentType = z.enum([
  "input_text",
  "input_audio",
  "input_image",
  "input_file",
  "output_text",
  "output_audio",
  "refusal",
]);

// Content schemas
const ItemContentInputText = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

const ItemContentInputImage = z.object({
  type: z.literal("input_image"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "low", "high"]).optional(),
  }),
});

const ItemContentInputFile = z.object({
  type: z.literal("input_file"),
  file: z.object({
    id: z.string(),
    purpose: z.string().optional(),
  }),
});

const ItemContentInputAudio = z.object({
  type: z.literal("input_audio"),
  input_audio: z.object({
    data: z.string(),
    format: z.enum(["wav", "mp3"]),
  }),
});

const ItemContentOutputText = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  logprobs: z
    .object({
      tokens: z.array(ChatCompletionTokenLogprob),
    })
    .optional(),
});

const ItemContentOutputAudio = z.object({
  type: z.literal("output_audio"),
  output_audio: z.object({
    id: z.string(),
    data: z.string().optional(),
    transcript: z.string().optional(),
    expires_at: z.number().int().optional(),
  }),
});

const ItemContentRefusal = z.object({
  type: z.literal("refusal"),
  refusal: z.string(),
});

// Union of all content types
const ItemContent = z.union([
  ItemContentInputText,
  ItemContentInputImage,
  ItemContentInputFile,
  ItemContentInputAudio,
  ItemContentOutputText,
  ItemContentOutputAudio,
  ItemContentRefusal,
]);

// Implicit user message
const ImplicitUserMessage = z.object({
  content: z.union([z.string(), z.array(ItemContent)]).optional(),
  role: z.literal("user").optional(),
});

// Basic item parameter types
const ItemType = z.enum([
  "message",
  "function_call",
  "function_call_output",
  "file_search_call",
  "code_interpreter_call",
  "computer_call",
  "computer_call_output",
  "web_search_call",
  "image_gen_call",
  "local_shell_call",
  "local_shell_call_output",
  "reasoning",
  "item_reference",
]);

// Basic message item param
const ResponsesMessageItemParam = z.object({
  type: z.literal("message"),
  role: ChatCompletionRoleExtended,
  content: z.array(ItemContent).optional(),
  name: z.string().optional(),
});

// Function call item param
const FunctionToolCallItemParam = z.object({
  type: z.literal("function_call"),
  name: z.string(),
  call_id: z.string(),
  arguments: z.string(),
});

const FunctionToolCallOutputItemParam = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

// Reasoning item param
const ReasoningItemParam = z.object({
  type: z.literal("reasoning"),
  content: z.string(),
});

// Item reference param
const ItemReferenceItemParam = z.object({
  type: z.literal("item_reference"),
  id: z.string(),
});

// Simplified ItemParam union (basic implementation)
const ItemParam = z.union([
  ResponsesMessageItemParam,
  FunctionToolCallItemParam,
  FunctionToolCallOutputItemParam,
  ReasoningItemParam,
  ItemReferenceItemParam,
]);

// OpenAI.Response schema converted to Response
const Response = z.object({
  // Required properties
  metadata: z.record(z.string(), z.string()).nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  top_p: z.number().min(0).max(1).nullable(),
  user: z.string().nullable(),
  id: z.string(),
  object: z.literal("response"),
  created_at: z.number().int(),
  error: ResponseError.nullable(),
  incomplete_details: z
    .object({
      reason: z.enum(["max_output_tokens", "content_filter"]),
    })
    .nullable(),
  output: z.array(ItemResource),
  instructions: z.union([z.string(), z.array(ItemParam)]).nullable(),
  parallel_tool_calls: z.boolean().default(true),

  // Optional properties
  top_logprobs: z.number().int().min(0).max(20).nullable().optional(),
  previous_response_id: z.string().nullable().optional(),
  reasoning: Reasoning.nullable().optional(),
  background: z.boolean().nullable().default(false).optional(),
  max_output_tokens: z.number().int().nullable().optional(),
  max_tool_calls: z.number().int().nullable().optional(),
  text: z
    .object({
      format: ResponseTextFormatConfiguration.optional(),
    })
    .optional(),
  tools: z.array(Tool).optional(),
  tool_choice: z.union([ToolChoiceOptions, ToolChoiceObject]).optional(),
  prompt: Prompt.nullable().optional(),
  truncation: z
    .enum(["auto", "disabled"])
    .nullable()
    .default("disabled")
    .optional(),
  status: z
    .enum([
      "completed",
      "failed",
      "in_progress",
      "cancelled",
      "queued",
      "incomplete",
    ])
    .optional(),
  output_text: z.string().nullable().optional(),
  usage: ResponseUsage.optional(),
});

// Response Stream Event schemas

// Response stream event types
const ResponseStreamEventType = z.union([
  z.string(),
  z.enum([
    "response.audio.delta",
    "response.audio.done",
    "response.audio_transcript.delta",
    "response.audio_transcript.done",
    "response.code_interpreter_call_code.delta",
    "response.code_interpreter_call_code.done",
    "response.code_interpreter_call.completed",
    "response.code_interpreter_call.in_progress",
    "response.code_interpreter_call.interpreting",
    "response.completed",
    "response.content_part.added",
    "response.content_part.done",
    "response.created",
    "error",
    "response.file_search_call.completed",
    "response.file_search_call.in_progress",
    "response.file_search_call.searching",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.in_progress",
    "response.failed",
    "response.incomplete",
    "response.output_item.added",
    "response.output_item.done",
    "response.refusal.delta",
    "response.refusal.done",
    "response.output_text.annotation.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_part.done",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.web_search_call.completed",
    "response.web_search_call.in_progress",
    "response.web_search_call.searching",
    "response.image_generation_call.completed",
    "response.image_generation_call.generating",
    "response.image_generation_call.in_progress",
    "response.image_generation_call.partial_image",
    "response.mcp_call.arguments_delta",
    "response.mcp_call.arguments_done",
    "response.mcp_call.completed",
    "response.mcp_call.failed",
    "response.mcp_call.in_progress",
    "response.mcp_list_tools.completed",
    "response.mcp_list_tools.failed",
    "response.mcp_list_tools.in_progress",
    "response.queued",
    "response.reasoning.delta",
    "response.reasoning.done",
    "response.reasoning_summary.delta",
    "response.reasoning_summary.done",
  ]),
]);

// Base ResponseStreamEvent schema
const BaseResponseStreamEvent = z.object({
  type: ResponseStreamEventType,
  sequence_number: z.number().int(),
});

// Individual event schemas
const ResponseCreatedEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.created"),
  response: Response,
});

const ResponseCompletedEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.completed"),
  response: Response,
});

const ResponseInProgressEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.in_progress"),
  response: Response,
});

const ResponseFailedEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.failed"),
  response: Response,
});

const ResponseIncompleteEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.incomplete"),
  response: Response,
});

const ResponseQueuedEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.queued"),
  response: Response,
});

const ResponseErrorEvent = BaseResponseStreamEvent.extend({
  type: z.literal("error"),
  code: z.string().nullable(),
  message: z.string(),
  param: z.string().nullable(),
});

const ResponseTextDeltaEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.output_text.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  delta: z.string(),
  obfuscation: z.string(),
});

const ResponseTextDoneEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.output_text.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
});

const ResponseOutputItemAddedEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.output_item.added"),
  output_index: z.number().int(),
  item: ItemResource,
});

const ResponseOutputItemDoneEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.output_item.done"),
  output_index: z.number().int(),
  item: ItemResource,
});

const ResponseContentPartAddedEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.content_part.added"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  part: ItemContent,
});

const ResponseContentPartDoneEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.content_part.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  part: ItemContent,
});

const ResponseRefusalDeltaEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.refusal.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  delta: z.string(),
  obfuscation: z.string(),
});

const ResponseRefusalDoneEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.refusal.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
});

const ResponseReasoningDeltaEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.reasoning.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  delta: z.string(),
  obfuscation: z.string(),
});

const ResponseReasoningDoneEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.reasoning.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
});

// Function call events
const ResponseFunctionCallArgumentsDeltaEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.function_call_arguments.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  call_id: z.string(),
  delta: z.string(),
  obfuscation: z.string(),
});

const ResponseFunctionCallArgumentsDoneEvent = BaseResponseStreamEvent.extend({
  type: z.literal("response.function_call_arguments.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  call_id: z.string(),
});

// Main discriminated union
const ResponseStreamEvent = z.discriminatedUnion("type", [
  ResponseCreatedEvent,
  ResponseCompletedEvent,
  ResponseInProgressEvent,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
  ResponseQueuedEvent,
  ResponseErrorEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseContentPartAddedEvent,
  ResponseContentPartDoneEvent,
  ResponseRefusalDeltaEvent,
  ResponseRefusalDoneEvent,
  ResponseReasoningDeltaEvent,
  ResponseReasoningDoneEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
]);

/**
 * POST /responses request body
 */
export const CreateResponse = z.object({
  // Required
  model: z.string(),

  // Basic parameters
  metadata: z.record(z.string(), z.string()).optional(),
  temperature: z.number().min(0).max(2).nullable().default(1).optional(),
  top_p: z.number().min(0).max(1).nullable().default(1).optional(),
  user: z.string().optional(),
  top_logprobs: z.number().int().min(0).max(20).optional(),

  // Advanced features
  previous_response_id: z.string().nullable().optional(),
  reasoning: Reasoning.nullable().optional(),
  background: z.boolean().nullable().default(false).optional(),
  max_output_tokens: z.number().int().nullable().optional(),
  max_tool_calls: z.number().int().nullable().optional(),

  // Text formatting
  text: z
    .object({
      format: ResponseTextFormatConfiguration.optional(),
    })
    .optional(),

  // Tools
  tools: z.array(Tool).optional(),
  tool_choice: z.union([ToolChoiceOptions, ToolChoiceObject]).optional(),

  // Prompt and input
  prompt: Prompt.nullable().optional(),
  truncation: z
    .enum(["auto", "disabled"])
    .nullable()
    .default("disabled")
    .optional(),
  input: z
    .union([z.string(), z.array(z.union([ImplicitUserMessage, ItemParam]))])
    .optional(),

  // Additional options
  include: z.array(Includable).nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().default(true).optional(),
  store: z.boolean().nullable().default(true).optional(),
  instructions: z.string().nullable().optional(),
  stream: z.boolean().nullable().default(false).optional(),
});
