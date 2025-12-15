import { z } from "@hono/zod-openapi";

const ReasoningEffort = z
  .enum(["low", "medium", "high"])
  .default("medium")
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

// Function and tool schemas
const FunctionObject = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.any()).optional(),
  strict: z.boolean().optional(),
});

const ServiceTier = z
  .enum(["auto", "default", "flex"])
  .default("auto")
  .nullable();

const ModelResponseProperties = z.looseObject({
  metadata: z.record(z.string(), z.string()).optional(),
  temperature: z.number().min(0).max(2).nullable().default(1).optional(),
  top_p: z.number().min(0).max(1).nullable().default(1).optional(),
  user: z.string().optional(),
  service_tier: ServiceTier.optional(),
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

const ResponseError = z
  .object({
    code: ResponseErrorCode,
    message: z.string(),
  })
  .nullable();

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

// Updated Reasoning schema to match OpenAI.Reasoning
const Reasoning = z.object({
  effort: ReasoningEffort.optional(),
  summary: z.enum(["auto", "concise", "detailed"]).nullable().optional(),
  generate_summary: z
    .enum(["auto", "concise", "detailed"])
    .nullable()
    .optional(),
});

const TextResponseFormatJsonSchema = z.object({
  type: z.literal("json_schema"),
  description: z.string().optional(),
  name: z.string(),
  schema: ResponseFormatJsonSchemaSchema,
  strict: z.boolean().default(false).nullable().optional(),
});

const TextResponseFormatConfiguration = z.union([
  ResponseFormatText,
  TextResponseFormatJsonSchema,
  ResponseFormatJsonObject,
]);

// Tool choice options (enum)
const ToolChoiceOptions = z.enum(["none", "auto", "required"]);

// Function tool (enhanced version)
const FunctionTool = FunctionObject.extend({
  type: z.literal("function"),
});

const RankingOptions = z.object({
  ranker: z.enum(["auto", "default-2024-11-15"]).optional(),
  score_threshold: z.number().min(0).max(1).optional(),
});

// File search tool
const FileSearchTool = z.object({
  type: z.literal("file_search"),
  vector_store_ids: z.array(z.string()),
  max_num_results: z.number().int().min(1).max(50).optional(),
  ranking_options: RankingOptions.optional(),
  filters: z.record(z.string(), z.any()).optional(),
});

// Code interpreter tool
const CodeInterpreterTool = z.looseObject({
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

const CodeInterpreterTextOutput = z.object({
  type: z.literal("logs"),
  logs: z.string(),
});

const CodeInterpreterFileOutput = z.object({
  type: z.literal("files"),
  files: z.array(
    z.object({
      mime_type: z.string(),
      file_id: z.string(),
    }),
  ),
});

const CodeInterpreterToolOutput = z.union([
  CodeInterpreterTextOutput,
  CodeInterpreterFileOutput,
]);

const CodeInterpreterToolCall = z.looseObject({
  id: z.string(),
  type: z.literal("code_interpreter_call"),
  code: z.string(),
  status: z.enum(["in_progress", "interpreting", "completed"]),
  results: z.array(CodeInterpreterToolOutput),
});

const ApproximateLocation = z.object({
  type: z.literal("approximate"),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  timezone: z.string().optional(),
});

// Web search tool
const WebSearchPreviewTool = z.object({
  type: z.string(), // web_search_preview, web_search_preview_2025_03_11
  user_location: ApproximateLocation.optional(),
  search_context_size: z
    .enum(["low", "medium", "high"])
    .default("medium")
    .optional(),
});

// Image generation tool
const ImageGenTool = z.looseObject({
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
  environment: z.enum(["windows", "mac", "linux", "ubuntu", "browser"]),
  display_width: z.number().int(),
  display_height: z.number().int(),
});

// Local shell tool
const LocalShellTool = z.looseObject({
  type: z.literal("local_shell"),
  local_shell: z
    .object({
      allowed_commands: z.array(z.string()).optional(),
      working_directory: z.string().optional(),
    })
    .optional(),
});

// MCP tool
const MCPTool = z.looseObject({
  type: z.literal("mcp"),
  mcp: z.object({
    server_name: z.string(),
    tool_name: z.string().optional(),
  }),
});

// Union of all tools
const Tool = z.union([
  FileSearchTool,
  FunctionTool,
  WebSearchPreviewTool,
  ComputerUsePreviewTool,
  // Not found in OpenAI YAML schema but keep for the future
  CodeInterpreterTool,
  ImageGenTool,
  LocalShellTool,
  MCPTool,
]);

const ToolChoiceFunction = z.object({
  type: z.literal("function"),
  name: z.string(),
});

const Includable = z.enum([
  "file_search_call.results",
  "message.input_image.image_url",
  "computer_call_output.output.image_url",
]);

const ToolChoiceTypes = z.object({
  // type: z.enum([
  //   "file_search",
  //   "web_search_preview",
  //   "computer_use_preview",
  //   "web_search_preview_2025_03_11",
  // ]),
  type: z.string(),
});

const ResponseProperties = z.object({
  previous_response_id: z.string().nullable().optional(),
  model: z.string(),
  reasoning: Reasoning.nullable().optional(),
  max_output_tokens: z.number().int().nullable().optional(),
  instruction: z.string().nullable().optional(),
  text: z
    .object({
      format: TextResponseFormatConfiguration.optional(),
    })
    .optional(),
  tools: z.array(Tool).optional(),
  tool_choice: z
    .union([ToolChoiceOptions, ToolChoiceTypes, ToolChoiceFunction])
    .optional(),
  truncation: z
    .enum(["auto", "disabled"])
    .nullable()
    .default("disabled")
    .optional(),
});

const InputTextContent = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

const InputImageContent = z.object({
  type: z.literal("input_image"),
  image_url: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
  detail: z.enum(["auto", "low", "high"]).default("auto"),
});

const InputFileContent = z.object({
  type: z.literal("input_file"),
  file_id: z.string().nullable(),
  filename: z.string().optional(),
  file_data: z.string().optional(),
});

const InputContent = z.union([
  InputTextContent,
  InputImageContent,
  InputFileContent,
]);

const InputMessageContentList = z.array(InputContent);

const EasyInputMessage = z.object({
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), InputMessageContentList]),
  type: z.literal("message").optional(),
});

const InputMessage = z.looseObject({
  type: z.literal("message"),
  role: z.enum(["user", "system", "developer"]),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
  content: InputMessageContentList,
});

const FileCitationBody = z.object({
  type: z.literal("file_citation"),
  file_id: z.string(),
  index: z.number().int(),
});

const UrlCitationBody = z.object({
  type: z.literal("url_citation"),
  url: z.string(),
  start_index: z.number().int(),
  end_index: z.number().int(),
  title: z.string(),
});

const FilePath = z.object({
  type: z.literal("file_path"),
  file_id: z.string(),
  index: z.number().int(),
});

const Annotation = z.discriminatedUnion("type", [
  FileCitationBody,
  UrlCitationBody,
  FilePath,
]);

const OutputTextContent = z.looseObject({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(Annotation),
});

const RefusalContent = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});

const OutputContent = z.union([OutputTextContent, RefusalContent]);

const OutputMessage = z.looseObject({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: OutputContent,
  status: z.enum(["in_progress", "completed", "incomplete"]),
});

const FileSearchToolCall = z.looseObject({
  id: z.string(),
  type: z.literal("file_search_call"),
  status: z.enum(["in_progress", "completed", "failed"]),
  queries: z.array(z.string()),
  results: z
    .array(
      z.object({
        file_id: z.string(),
        text: z.string(),
        filename: z.string().optional(),
        attributes: z.any().optional(),
        score: z.number(),
      }),
    )
    .nullable()
    .optional(),
});

const Click = z.object({
  type: z.literal("click"),
  button: z.enum(["left", "right", "wheel", "back", "forward"]).optional(),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
});

const DoubleClick = z.object({
  type: z.literal("double_click"),
  x: z.number().int(),
  y: z.number().int(),
});

const Drag = z.object({
  type: z.literal("drag"),
  path: z
    .array(
      z.object({
        x: z.number().int(),
        y: z.number().int(),
      }),
    )
    .optional(),
});

const KeyPress = z.object({
  type: z.literal("keypress"),
  keys: z.array(z.string()),
});

const Move = z.object({
  type: z.literal("move"),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
});

const Screenshot = z.object({
  type: z.literal("screenshot"),
});

const Scroll = z.object({
  type: z.literal("scroll"),
  x: z.number().int().optional(),
  y: z.number().int().optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
});

const Type = z.object({
  type: z.literal("type"),
  text: z.string(),
});

const Wait = z.object({
  type: z.literal("wait"),
  duration: z.number().optional(),
});

const ComputerAction = z.discriminatedUnion("type", [
  Click,
  DoubleClick,
  Drag,
  KeyPress,
  Move,
  Screenshot,
  Scroll,
  Type,
  Wait,
]);

const ComputerToolCallSafetyCheck = z.looseObject({
  id: z.string(),
  code: z.string(),
  message: z.string(),
});

const ComputerCallSafetyCheckParam = z.object({
  id: z.string(),
  code: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});

const ComputerToolCall = z.looseObject({
  id: z.string(),
  type: z.literal("computer_call"),
  call_id: z.string().optional(),
  action: ComputerAction,
  pending_safety_checks: z.array(ComputerToolCallSafetyCheck),
  status: z.enum(["in_progress", "completed", "failed"]),
});

const ComputerScreenshotImage = z.looseObject({
  type: z.literal("computer_screenshot"),
  image_url: z.string().optional(),
  file_id: z.string().optional(),
});

const ComputerCallOutputItemParam = z.looseObject({
  id: z.string().nullable().optional(),
  call_id: z.string().min(1).max(64),
  type: z.literal("computer_call_output"),
  output: ComputerScreenshotImage,
  acknowledged_safety_checks: z
    .array(ComputerCallSafetyCheckParam)
    .nullable()
    .optional(),
  status: z.enum(["in_progress", "completed", "failed"]).nullable().optional(),
});

const WebSearchToolCall = z.looseObject({
  id: z.string(),
  type: z.literal("web_search_call"),
  status: z.enum(["in_progress", "completed", "failed"]),
});

const FunctionToolCall = z.looseObject({
  id: z.string().optional(),
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.enum(["in_progress", "completed", "failed"]).optional(),
});

const FunctionCallOutputItemParam = z.looseObject({
  id: z.string().nullable().optional(),
  call_id: z.string().min(1).max(64),
  type: z.literal("function_call_output"),
  output: z.string().max(10485760),
  status: z.enum(["in_progress", "completed", "failed"]).nullable().optional(),
});

const ReasoningItem = z.looseObject({
  id: z.string(),
  type: z.literal("reasoning"),
  summary: z.array(
    z.object({ type: z.literal("summary_text"), text: z.string() }),
  ),
  status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
});

const Item = z.discriminatedUnion("type", [
  InputMessage,
  OutputMessage,
  FileSearchToolCall,
  ComputerToolCall,
  ComputerCallOutputItemParam,
  WebSearchToolCall,
  FunctionToolCall,
  FunctionCallOutputItemParam,
  ReasoningItem,
]);

const ItemReferenceParam = z.object({
  type: z.literal("item_reference").nullable().optional(),
  id: z.string(),
});

/**
 * POST /responses request body
 */
export const CreateResponse = ModelResponseProperties.extend({
  ...ResponseProperties,
  input: z
    .union([
      z.string(),
      z.array(z.union([EasyInputMessage, Item, ItemReferenceParam])),
    ])
    .optional(),
  include: z.array(Includable).nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().default(true).optional(),
  store: z.boolean().nullable().default(true).optional(),
  stream: z.boolean().nullable().default(false).optional(),
}).describe(
  "The request body to create a model response for /responses API. Docs: https://platform.openai.com/docs/api-reference/responses/create",
);

const OutputItem = z.discriminatedUnion("type", [
  OutputMessage,
  FileSearchToolCall,
  FunctionToolCall,
  WebSearchToolCall,
  ComputerToolCall,
  ReasoningItem,
]);

/**
 * POST /responses application/json response
 */
export const CreateResponseResponse = ModelResponseProperties.extend({
  ...ResponseProperties,
  id: z.string(),
  object: z.literal("response"),
  status: z.enum(["completed", "failed", "in_progress", "incomplete"]),
  created_at: z.number().int(),
  error: ResponseError,
  incomplete_details: z
    .object({
      reason: z.enum(["max_output_tokens", "content_filter"]).optional(),
    })
    .nullable(),
  output: OutputItem,
  output_text: z.string().nullable().optional(),
  usage: ResponseUsage,
  parallel_tool_calls: z.boolean().nullable().default(true),
}).describe(
  "The response in application/json type of /responses API. Docs: https://platform.openai.com/docs/api-reference/responses/create",
);

const ResponseAudioDeltaEvent = z.looseObject({
  type: z.literal("response.audio.delta"),
  delta: z.string(), // base64 format
  response_id: z.string().optional(),
});

const ResponseAudioDoneEvent = z.looseObject({
  type: z.literal("response.audio.done"),
  response_id: z.string(),
});

const ResponseAudioTranscriptDeltaEvent = z.looseObject({
  type: z.literal("response.audio.transcript.delta"),
  delta: z.string(),
  response_id: z.string().optional(),
});

const ResponseAudioTranscriptDoneEvent = z.looseObject({
  type: z.literal("response.audio.transcript.done"),
  response_id: z.string(),
});

const ResponseCodeInterpreterCallCodeDeltaEvent = z.looseObject({
  type: z.literal("response.code_interpreter_call.code.delta"),
  output_index: z.number().int(),
  delta: z.string(),
  response_id: z.string().optional(),
});

const ResponseCodeInterpreterCallCodeDoneEvent = z.looseObject({
  type: z.literal("response.code_interpreter_call.code.done"),
  output_index: z.number().int(),
  code: z.string(),
  response_id: z.string(),
});

const ResponseCodeInterpreterCallCompletedEvent = z.looseObject({
  type: z.literal("response.code_interpreter_call.completed"),
  output_index: z.number().int(),
  code_interpreter_call: CodeInterpreterToolCall,
  response_id: z.string(),
});

const ResponseCodeInterpreterCallInProgressEvent = z.looseObject({
  type: z.literal("response.code_interpreter_call.in_progress"),
  output_index: z.number().int(),
  code_interpreter_call: CodeInterpreterToolCall,
  response_id: z.string().optional(),
});

const ResponseCodeInterpreterCallInterpretingEvent = z.looseObject({
  type: z.literal("response.code_interpreter_call.interpreting"),
  output_index: z.number().int(),
  code_interpreter_call: CodeInterpreterToolCall,
  response_id: z.string().optional(),
});

const ResponseFileSearchCallCompletedEvent = z.looseObject({
  type: z.literal("response.file_search_call.completed"),
  output_index: z.number().int(),
  item_id: z.string(),
});

const ResponseCompletedEvent = z.looseObject({
  type: z.literal("response.completed"),
  response: CreateResponseResponse,
});

const ResponseContentPartAddedEvent = z.looseObject({
  type: z.literal("response.content_part.added"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  part: OutputContent,
});

const ResponseContentPartDoneEvent = z.looseObject({
  type: z.literal("response.content_part.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  part: OutputContent,
});

const ResponseCreatedEvent = z.looseObject({
  type: z.literal("response.created"),
  response: CreateResponseResponse,
});

const ResponseErrorEvent = z.looseObject({
  type: z.literal("error"),
  code: z.string().nullable(),
  message: z.string(),
  param: z.string().nullable(),
});

export const CommonResponseError = z.looseObject({
  error: z.looseObject({
    type: z.string(),
    message: z.string(),
    param: z.string().nullable(),
    code: z.string().nullable(),
    log_file: z.string().optional(),
  }),
});

const ResponseFileSearchCallInProgressEvent = z.looseObject({
  type: z.literal("response.file_search_call.in_progress"),
  output_index: z.number().int(),
  item_id: z.string(),
});

const ResponseFileSearchCallSearchingEvent = z.looseObject({
  type: z.literal("response.file_search_call.searching"),
  output_index: z.number().int(),
  item_id: z.string(),
});

const ResponseFunctionCallArgumentsDeltaEvent = z.looseObject({
  type: z.literal("response.function_call_arguments.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  delta: z.string(),
});

const ResponseFunctionCallArgumentsDoneEvent = z.looseObject({
  type: z.literal("response.function_call_arguments.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  arguments: z.string(),
});

const ResponseInProgressEvent = z.looseObject({
  type: z.literal("response.in_progress"),
  response: CreateResponseResponse,
});

const ResponseFailedEvent = z.looseObject({
  type: z.literal("response.failed"),
  response: CreateResponseResponse,
});

const ResponseIncompleteEvent = z.looseObject({
  type: z.literal("response.incomplete"),
  response: CreateResponseResponse,
});

const ResponseOutputItemAddedEvent = z.looseObject({
  type: z.literal("response.output_item.added"),
  output_index: z.number().int(),
  item: OutputItem,
});

const ResponseOutputItemDoneEvent = z.looseObject({
  type: z.literal("response.output_item.done"),
  output_index: z.number().int(),
  item: OutputItem,
});

const ResponseReasoningSummaryPartAddedEvent = z.looseObject({
  type: z.literal("response.reasoning_summary_part.added"),
  item_id: z.string(),
  output_index: z.number().int(),
  summary_index: z.number().int(),
  part: z.object({
    type: z.literal("summary_text"),
    text: z.string(),
  }),
});

const ResponseReasoningSummaryPartDoneEvent = z.looseObject({
  type: z.literal("response.reasoning_summary_part.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  summary_index: z.number().int(),
  part: z.object({
    type: z.literal("summary_text"),
    text: z.string(),
  }),
});

const ResponseReasoningSummaryTextDeltaEvent = z.looseObject({
  type: z.literal("response.reasoning_summary_text.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  summary_index: z.number().int(),
  delta: z.string(),
});

const ResponseReasoningSummaryTextDoneEvent = z.looseObject({
  type: z.literal("response.reasoning_summary_text.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  summary_index: z.number().int(),
  text: z.string(),
});

const ResponseRefusalDeltaEvent = z.looseObject({
  type: z.literal("response.refusal.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  delta: z.string(),
});

const ResponseRefusalDoneEvent = z.looseObject({
  type: z.literal("response.refusal.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  refusal: z.string(),
});

const ResponseTextAnnotationDeltaEvent = z.looseObject({
  type: z.literal("response.output_text.annotation.added"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  annotation_index: z.number().int(),
  annotation: Annotation,
});

const ResponseTextDeltaEvent = z.looseObject({
  type: z.literal("response.output_text.delta"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  delta: z.string(),
});

const ResponseTextDoneEvent = z.looseObject({
  type: z.literal("response.output_text.done"),
  item_id: z.string(),
  output_index: z.number().int(),
  content_index: z.number().int(),
  text: z.string(),
});

const ResponseWebSearchCallCompletedEvent = z.looseObject({
  type: z.literal("response.web_search_call.completed"),
  output_index: z.number().int(),
  item_id: z.string(),
});

const ResponseWebSearchCallInProgressEvent = z.looseObject({
  type: z.literal("response.web_search_call.in_progress"),
  output_index: z.number().int(),
  item_id: z.string(),
});

const ResponseWebSearchCallSearchingEvent = z.looseObject({
  type: z.literal("response.web_search_call.searching"),
  output_index: z.number().int(),
  item_id: z.string(),
});

/**
 * POST /responses text/event-stream response
 */
export const ResponseStreamEvent = z
  .discriminatedUnion("type", [
    ResponseAudioDeltaEvent,
    ResponseAudioDoneEvent,
    ResponseAudioTranscriptDeltaEvent,
    ResponseAudioTranscriptDoneEvent,
    ResponseCodeInterpreterCallCodeDeltaEvent,
    ResponseCodeInterpreterCallCodeDoneEvent,
    ResponseCodeInterpreterCallCompletedEvent,
    ResponseCodeInterpreterCallInProgressEvent,
    ResponseCodeInterpreterCallInterpretingEvent,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseErrorEvent,
    ResponseFileSearchCallCompletedEvent,
    ResponseFileSearchCallInProgressEvent,
    ResponseFileSearchCallSearchingEvent,
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseFunctionCallArgumentsDoneEvent,
    ResponseInProgressEvent,
    ResponseFailedEvent,
    ResponseIncompleteEvent,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseReasoningSummaryPartAddedEvent,
    ResponseReasoningSummaryPartDoneEvent,
    ResponseReasoningSummaryTextDeltaEvent,
    ResponseReasoningSummaryTextDoneEvent,
    ResponseRefusalDeltaEvent,
    ResponseRefusalDoneEvent,
    ResponseTextAnnotationDeltaEvent,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
    ResponseWebSearchCallCompletedEvent,
    ResponseWebSearchCallInProgressEvent,
    ResponseWebSearchCallSearchingEvent,
  ])
  .describe(
    "The response in text/event-stream type of /responses API. Docs: https://platform.openai.com/docs/api-reference/responses/create",
  );
