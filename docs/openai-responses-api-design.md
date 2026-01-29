# OpenAI Responses API Design

## Overview

The OpenAI Responses API (`POST /v1/responses`) is a newer API that provides a different interface from the Chat Completions API. This document outlines the design for supporting this API in Agent Maestro.

## API Comparison: Chat Completions vs Responses

| Aspect               | Chat Completions (`/chat/completions`)        | Responses (`/responses`)                                               |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| **Input format**     | `messages` array with role/content            | `input` (string or array of items)                                     |
| **System prompt**    | `system` role in messages or `developer` role | Dedicated `instruction` field                                          |
| **Response format**  | `choices[].message`                           | `output` array of items                                                |
| **Tool calls**       | In `choices[].message.tool_calls`             | Separate `function_call` items in `output`                             |
| **Streaming events** | `chat.completion.chunk` object                | Fine-grained events (e.g., `response.output_text.delta`)               |
| **Multi-turn**       | Manual message history management             | `previous_response_id` / `conversation`                                |
| **Reasoning**        | Not supported                                 | `reasoning` object with effort/summary                                 |
| **Response ID**      | `id` in response only                         | `id` that can reference previous responses                             |
| **Tool types**       | Function tools only                           | Function, file_search, web_search, computer_use, code_interpreter, mcp |

## Key Endpoints

### POST /v1/responses

- **Purpose**: Create a model response with optional streaming
- **Input**: `CreateResponse` schema (see `src/server/schemas/openai.ts`)
- **Output**:
  - Non-streaming: `CreateResponseResponse` JSON
  - Streaming: `ResponseStreamEvent` SSE events
- **Features**:
  - Convert Responses API input to VSCode `LanguageModelChatMessage[]`
  - Support `instruction` field for system-level instructions
  - Handle function calling via `tools` array
  - Support both streaming and non-streaming modes

## Data Structure Mappings

### Input Conversion: Responses API → VSCode

**Responses API Input Structure:**

```typescript
// String input (simple case)
input: "Hello, how are you?";

// Array input (complex case)
input: [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Hello" }],
  },
  {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Hi!" }],
  },
  {
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: "{}",
  },
  { type: "function_call_output", call_id: "call_1", output: '{"temp": 72}' },
];

// EasyInputMessage (shorthand)
input: [
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi there!" },
];
```

**VSCode Structure:**

```typescript
vscode.LanguageModelChatMessage.User(parts);
vscode.LanguageModelChatMessage.Assistant(parts);
// Parts: LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart
```

**Mapping Logic:**

| Responses API                          | VSCode LM                                   |
| -------------------------------------- | ------------------------------------------- |
| `input: string`                        | `User([TextPart(input)])`                   |
| `instruction: string`                  | `User([TextPart(instruction)])` (prepended) |
| `{type: "message", role: "user"}`      | `User(convertedParts)`                      |
| `{type: "message", role: "system"}`    | `User(convertedParts)`                      |
| `{type: "message", role: "developer"}` | `User(convertedParts)`                      |
| `{type: "message", role: "assistant"}` | `Assistant(convertedParts)`                 |
| `{type: "function_call"}`              | `Assistant([ToolCallPart])`                 |
| `{type: "function_call_output"}`       | `User([ToolResultPart])`                    |
| `EasyInputMessage`                     | Converted based on role                     |

**Content Part Mapping:**

| Input Part                         | VSCode Part                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `{type: "input_text", text}`       | `TextPart(text)`                                                          |
| `{type: "output_text", text}`      | `TextPart(text)`                                                          |
| `{type: "refusal", refusal}`       | `TextPart(refusal)`                                                       |
| `{type: "input_image", image_url}` | `DataPart(mimeType, data)` if base64 data URI, otherwise `TextPart(JSON)` |
| `{type: "input_file", ...}`        | `TextPart(JSON)` (not supported)                                          |

**Image Handling:**

```typescript
if (content.type === "input_image" && content.image_url) {
  // Parse data URI: data:image/png;base64,<data>
  const match = content.image_url.match(/^data:(image\/\w+);base64,(.+)$/);
  if (match) {
    const mimeType = match[1]; // e.g., "image/png"
    const base64Data = match[2];
    return new vscode.LanguageModelDataPart(mimeType, Buffer.from(base64Data, "base64"));
  }
  // URL-based images not supported, fallback to JSON
  return new vscode.LanguageModelTextPart(JSON.stringify(content));
}
```

### Output Conversion: VSCode → Responses API

**VSCode Stream:**

```typescript
for await (const chunk of response.stream) {
  if (chunk instanceof vscode.LanguageModelTextPart) { ... }
  else if (chunk instanceof vscode.LanguageModelToolCallPart) { ... }
}
```

**Responses API Output:**

```typescript
{
  id: "resp_AM-1706500000-a1b2c3d4",
  object: "response",
  status: "completed",
  created_at: 1706500000, // Unix timestamp (integer, use Math.floor(Date.now() / 1000))
  model: "gpt-4",
  output: [
    {
      type: "message",
      id: "msg_AM-a1b2c3d4e5f6",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello!", annotations: [] }], // annotations always empty
      status: "completed"
    },
    {
      type: "function_call",
      id: "fc_AM-a1b2c3d4e5f6",
      call_id: "call_AM-a1b2c3d4e5f6",
      name: "get_weather",
      arguments: "{\"location\": \"NYC\"}",
      status: "completed"
    }
  ],
  error: null,
  incomplete_details: null, // Set to { reason: "max_output_tokens" } if truncated
  usage: {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 20,
    output_tokens_details: { reasoning_tokens: 0 }, // Always 0
    total_tokens: 30
  },
  metadata: {} // Pass through from request
}
```

### Tools Conversion

**Responses API Tools:**

```typescript
tools: [
  {
    type: "function",
    name: "get_weather",
    description: "Get weather for a location",
    parameters: { type: "object", properties: { ... } },
    strict: true
  },
  { type: "web_search_preview" },  // Not supported
  { type: "file_search", ... },     // Not supported
  { type: "code_interpreter" },     // Not supported
  { type: "computer_use_preview" }, // Not supported
  { type: "mcp", ... }              // Not supported
]
```

**VSCode LM Tools:**

```typescript
[
  {
    name: "get_weather",
    description: "Get weather for a location",
    inputSchema: { type: "object", properties: { ... } }
  }
]
```

**Tool Choice Mapping:**

| Responses API                                  | VSCode LM                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `tool_choice: "none"`                          | Don't pass `tools` array (or pass empty array)                                     |
| `tool_choice: "auto"`                          | `toolMode: LanguageModelChatToolMode.Auto`                                         |
| `tool_choice: "required"`                      | `toolMode: LanguageModelChatToolMode.Required`                                     |
| `tool_choice: {type: "function", name: "..."}` | `toolMode: LanguageModelChatToolMode.Required` (specific function not enforceable) |

Note: VSCode LM API only has `Auto` and `Required` modes. There is no `None` mode, so we simply don't pass tools when `tool_choice: "none"`.

## Streaming Event Mapping

For `stream: true`, the Responses API emits fine-grained events. Here's how we map VSCode stream chunks to Responses API events:

### Event Flow

1. **Response lifecycle events:**

   - `response.created` - Emit immediately with initial response object
   - `response.in_progress` - Emit after created event
   - `response.completed` / `response.failed` / `response.incomplete` - Emit at end

2. **Output item events:**

   - `response.output_item.added` - When starting a new message or function_call
   - `response.output_item.done` - When output item is complete

3. **Content events (for text):**

   - `response.content_part.added` - When starting text content
   - `response.output_text.delta` - For each text chunk from VSCode
   - `response.output_text.done` - When text is complete
   - `response.content_part.done` - When content part is complete

4. **Function call events:**
   - `response.function_call_arguments.delta` - For function argument chunks
   - `response.function_call_arguments.done` - When arguments complete

### Streaming Implementation Pattern

```typescript
return streamSSE(c, async (stream) => {
  const responseId = generateResponseId();
  const createdAt = Math.floor(Date.now() / 1000); // Unix timestamp (integer)

  // 1. Emit response.created
  await emitEvent(stream, "response.created", { response: initialResponse });

  // 2. Emit response.in_progress
  await emitEvent(stream, "response.in_progress", { response: inProgressResponse });

  // 3. Process VSCode stream
  let outputIndex = 0;
  let currentMessageId: string | null = null;

  for await (const chunk of response.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      if (!currentMessageId) {
        // Emit output_item.added for new message
        currentMessageId = generateMessageId();
        await emitEvent(stream, "response.output_item.added", { ... });
        await emitEvent(stream, "response.content_part.added", { ... });
      }
      // Emit text delta
      await emitEvent(stream, "response.output_text.delta", {
        item_id: currentMessageId,
        output_index: outputIndex,
        content_index: 0,
        delta: chunk.value
      });
    } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
      // Close current message if any
      if (currentMessageId) {
        await emitEvent(stream, "response.output_item.done", { ... });
        outputIndex++;
        currentMessageId = null;
      }
      // Emit function call events
      const fcId = generateFunctionCallId();
      await emitEvent(stream, "response.output_item.added", { ... });
      await emitEvent(stream, "response.function_call_arguments.delta", { ... });
      await emitEvent(stream, "response.function_call_arguments.done", { ... });
      await emitEvent(stream, "response.output_item.done", { ... });
      outputIndex++;
    }
  }

  // 4. Emit response.completed
  await emitEvent(stream, "response.completed", { response: finalResponse });
});
```

## Unsupported Features

The following features cannot be fully supported via VSCode Language Model API:

### 1. Multi-turn State Management

| Feature                | Status        | Workaround                        |
| ---------------------- | ------------- | --------------------------------- |
| `previous_response_id` | Not supported | Return 400 error with explanation |
| `conversation`         | Not supported | Return 400 error with explanation |

**Rationale**: Agent Maestro is stateless; it doesn't persist responses. Clients must send full conversation history in the `input` array.

**Error Response:**

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "previous_response_id is not supported. Agent Maestro is stateless. Please send full conversation history in the input array.",
    "param": "previous_response_id",
    "code": "unsupported_parameter"
  }
}
```

### 2. Specialized Tools

| Tool Type              | Status        | Reason                          |
| ---------------------- | ------------- | ------------------------------- |
| `function`             | Supported     | Maps to VSCode LM tools         |
| `file_search`          | Not supported | Requires OpenAI vector store    |
| `web_search_preview`   | Not supported | No VSCode LM equivalent         |
| `code_interpreter`     | Not supported | No VSCode LM equivalent         |
| `computer_use_preview` | Not supported | No VSCode LM equivalent         |
| `image_gen`            | Not supported | No VSCode LM equivalent         |
| `local_shell`          | Not supported | Security concerns               |
| `mcp`                  | Not supported | Requires MCP server integration |

**Behavior**: If unsupported tools are provided, filter them out with a warning log. Only `function` tools are passed to VSCode LM.

### 3. Reasoning Features

| Feature                      | Status         | Notes                                  |
| ---------------------------- | -------------- | -------------------------------------- |
| `reasoning.effort`           | Passed through | May not affect VSCode LM behavior      |
| `reasoning.generate_summary` | Not supported  | No reasoning token access in VSCode LM |
| `ReasoningItem` in output    | Not supported  | VSCode LM doesn't expose reasoning     |

### 4. Other Unsupported Parameters

| Parameter          | Status  | Notes                                       |
| ------------------ | ------- | ------------------------------------------- |
| `store`            | Ignored | No storage capability                       |
| `include`          | Ignored | No additional data to include               |
| `background`       | Ignored | No background execution support             |
| `prompt_cache_key` | Ignored | No prompt caching support                   |
| `service_tier`     | Ignored | No service tier differentiation             |
| `truncation`       | Partial | VSCode LM handles context limits internally |

## File Structure

### Files to Create

#### 1. `src/server/routes/openaiResponsesRoutes.ts`

Main route handler for `/v1/responses`:

```typescript
export function registerOpenaiResponsesRoutes(app: OpenAPIHono) {
  // POST /v1/responses
  app.openapi(createResponseRoute, async (c: Context): Promise<Response> => {
    // 1. Validate unsupported parameters
    // 2. Get chat model client
    // 3. Convert input to VSCode LM messages
    // 4. Send request to VSCode LM
    // 5. Convert response to Responses API format
    // 6. Handle streaming if requested
  });
}
```

#### 2. `src/server/utils/openaiResponses.ts`

Conversion utilities:

```typescript
// Input conversion
export const convertResponsesInputToVSCode = (
  input: string | InputItem[],
  instruction?: string | null
): vscode.LanguageModelChatMessage[] => { ... };

// Single item conversion
export const convertResponsesItemToVSCode = (
  item: InputItem
): vscode.LanguageModelChatMessage | null => { ... };

// Content part conversion
export const convertInputContentToVSCodePart = (
  content: InputContent
): vscode.LanguageModelTextPart | vscode.LanguageModelDataPart => { ... };

// Tool conversion (filter unsupported)
export const convertResponsesToolsToVSCode = (
  tools?: Tool[]
): vscode.LanguageModelChatTool[] => { ... };

// Output building
export const buildResponseOutput = (
  textContent: string,
  toolCalls: vscode.LanguageModelToolCallPart[]
): OutputItem[] => { ... };

// ID generation
export const generateResponseId = (): string => `resp_AM-${Date.now()}-${randomString(8)}`;
export const generateMessageId = (): string => `msg_AM-${randomString(12)}`;
export const generateFunctionCallId = (): string => `fc_AM-${randomString(12)}`;
export const generateCallId = (): string => `call_AM-${randomString(12)}`;
```

### Files to Modify

#### `src/server/routes/openaiRoutes.ts`

Add import and registration:

```typescript
import { registerOpenaiResponsesRoutes } from "./openaiResponsesRoutes";

export function registerOpenaiRoutes(app: OpenAPIHono) {
  // Existing /chat/completions route...

  // Register /v1/responses routes
  registerOpenaiResponsesRoutes(app);
}
```

Alternatively, register in `ProxyServer.ts` if keeping routes separate.

#### `src/server/schemas/openai.ts`

Already has `CreateResponse`, `CreateResponseResponse`, and `ResponseStreamEvent` schemas. May need minor updates:

- Export types for use in route handlers
- Add any missing event types

## Implementation Details

### Request Validation

```typescript
const requestBody = await c.req.json();

// Check for unsupported stateful parameters
if (requestBody.previous_response_id) {
  return c.json({
    error: {
      type: "invalid_request_error",
      message: "previous_response_id is not supported. Agent Maestro is stateless. Please send full conversation history in the input array.",
      param: "previous_response_id",
      code: "unsupported_parameter"
    }
  }, 400);
}

if (requestBody.conversation) {
  return c.json({
    error: {
      type: "invalid_request_error",
      message: "conversation parameter is not supported. Agent Maestro is stateless. Please send full conversation history in the input array.",
      param: "conversation",
      code: "unsupported_parameter"
    }
  }, 400);
}

// Validate required fields
if (!requestBody.model) {
  return c.json({
    error: {
      type: "invalid_request_error",
      message: "model is required",
      param: "model",
      code: "missing_required_parameter"
    }
  }, 400);
}

// Input validation: need either input or instruction
if (!requestBody.input && !requestBody.instruction) {
  return c.json({
    error: {
      type: "invalid_request_error",
      message: "Either input or instruction is required",
      param: "input",
      code: "missing_required_parameter"
    }
  }, 400);
}
```

### Request Options Building

```typescript
// Build VSCode LM request options
const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
  justification:
    "OpenAI Responses API endpoint using VS Code Language Model API",
  modelOptions: {
    // Pass through max_output_tokens
    maxTokens: requestBody.max_output_tokens,
    // Pass through other generation config
    temperature: requestBody.temperature,
    top_p: requestBody.top_p,
  },
  tools:
    requestBody.tool_choice === "none"
      ? undefined
      : convertResponsesToolsToVSCode(requestBody.tools),
  toolMode: convertToolChoice(requestBody.tool_choice),
};

// Tool choice conversion helper
const convertToolChoice = (
  toolChoice: unknown,
): vscode.LanguageModelChatToolMode | undefined => {
  if (!toolChoice || toolChoice === "none") {
    return undefined;
  }
  if (
    toolChoice === "required" ||
    (typeof toolChoice === "object" && toolChoice.type === "function")
  ) {
    return vscode.LanguageModelChatToolMode.Required;
  }
  return vscode.LanguageModelChatToolMode.Auto; // Default for "auto"
};
```

### EasyInputMessage Detection

The API supports both full `InputMessage` and shorthand `EasyInputMessage`:

```typescript
const isEasyInputMessage = (item: unknown): item is EasyInputMessage => {
  return (
    typeof item === "object" &&
    item !== null &&
    "role" in item &&
    "content" in item &&
    (!("type" in item) || item.type === "message")
  );
};

const convertEasyInputMessage = (
  msg: EasyInputMessage,
): vscode.LanguageModelChatMessage => {
  const content =
    typeof msg.content === "string"
      ? msg.content
      : msg.content.map(convertInputContentToVSCodePart);

  switch (msg.role) {
    case "user":
      return vscode.LanguageModelChatMessage.User(content);
    case "assistant":
      return vscode.LanguageModelChatMessage.Assistant(content);
    case "system":
    case "developer":
      return vscode.LanguageModelChatMessage.User(content);
  }
};
```

### Token Counting

```typescript
// Input tokens: count full request payload
const requestBodyStr = JSON.stringify(requestBody);
const inputTokenCount = await client.countTokens(
  requestBodyStr,
  cancellationToken,
);

// Output tokens: count accumulated response
let accumulatedText = "";
for await (const chunk of response.stream) {
  accumulatedText += JSON.stringify(chunk);
}
const outputTokenCount = await client.countTokens(
  accumulatedText,
  cancellationToken,
);

// Build usage object
const usage = {
  input_tokens: inputTokenCount,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: outputTokenCount,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: inputTokenCount + outputTokenCount,
};
```

### Error Handling

**Non-streaming errors:**

```typescript
try {
  // ... request handling
} catch (error) {
  logger.error("✕ /v1/responses |", error);

  const logFilePath = await handleErrorWithLogging({
    requestBody: rawRequestBody,
    inputTokens,
    lmChatMessages,
    error,
    endpoint: "/api/openai/v1/responses",
    modelId: requestedModelId,
  });

  return c.json({
    error: {
      type: "internal_error",
      message: error instanceof Error ? error.message : "Internal server error",
      param: null,
      code: null,
      log_file: logFilePath,
    }
  }, 500);
}
```

**Streaming errors:**

When an error occurs during streaming, emit a `response.failed` event:

```typescript
return streamSSE(c, async (stream) => {
  // ... normal streaming logic
}, async (error, stream) => {
  // Error callback for streamSSE
  logger.error("✕ /v1/responses (stream) |", error);

  await stream.writeSSE({
    event: "response.failed",
    data: JSON.stringify({
      type: "response.failed",
      response: {
        id: responseId,
        object: "response",
        status: "failed",
        created_at: createdAt,
        model: modelId,
        output: [],
        error: {
          code: "server_error",
          message: error instanceof Error ? error.message : String(error)
        },
        incomplete_details: null,
        usage: null,
        metadata: requestBody.metadata ?? {}
      }
    })
  });
});
```

### Non-Streaming Response Flow

Complete flow for non-streaming requests:

```typescript
app.openapi(createResponseRoute, async (c: Context): Promise<Response> => {
  let rawRequestBody: unknown;
  let lmChatMessages: vscode.LanguageModelChatMessage[] | undefined;
  let requestedModelId = "";
  let inputTokens = 0;

  try {
    // 1. Parse and validate request
    const requestBody = await c.req.json();
    rawRequestBody = requestBody;
    requestedModelId = requestBody.model;

    // Validate unsupported parameters
    if (requestBody.previous_response_id) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "...",
            param: "previous_response_id",
            code: "unsupported_parameter",
          },
        },
        400,
      );
    }

    // 2. Get chat model client
    const { client, error: clientError } = await getChatModelClient(
      requestBody.model,
    );
    if (clientError) {
      return c.json(clientError, 404);
    }

    // 3. Count input tokens
    const requestBodyStr = JSON.stringify(requestBody);
    const cancellationToken = new vscode.CancellationTokenSource().token;
    inputTokens = await client.countTokens(requestBodyStr, cancellationToken);

    logger.info(
      `→ /v1/responses | model: ${requestBody.model} | input: ${inputTokens}`,
    );

    // 4. Convert input to VSCode messages
    const vsCodeMessages = convertResponsesInputToVSCode(
      requestBody.input,
      requestBody.instruction,
    );
    lmChatMessages = vsCodeMessages;

    // 5. Convert tools and build request options
    const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
      justification: "OpenAI Responses API endpoint",
      modelOptions: { maxTokens: requestBody.max_output_tokens },
      tools:
        requestBody.tool_choice === "none"
          ? undefined
          : convertResponsesToolsToVSCode(requestBody.tools),
      toolMode: convertToolChoice(requestBody.tool_choice),
    };

    // 6. Send request to VSCode LM
    const response = await client.sendRequest(
      vsCodeMessages,
      lmRequestOptions,
      cancellationToken,
    );

    // 7. Collect response
    const output: OutputItem[] = [];
    let accumulatedText = "";
    const toolCalls: { callId: string; name: string; input: unknown }[] = [];

    for await (const chunk of response.stream) {
      if (chunk instanceof vscode.LanguageModelTextPart) {
        accumulatedText += chunk.value;
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          callId: chunk.callId,
          name: chunk.name,
          input: chunk.input,
        });
      }
    }

    // 8. Build output array
    if (accumulatedText) {
      output.push({
        type: "message",
        id: generateMessageId(),
        role: "assistant",
        content: [
          { type: "output_text", text: accumulatedText, annotations: [] },
        ],
        status: "completed",
      });
    }
    for (const tc of toolCalls) {
      output.push({
        type: "function_call",
        id: generateFunctionCallId(),
        call_id: tc.callId,
        name: tc.name,
        arguments: JSON.stringify(tc.input ?? {}),
        status: "completed",
      });
    }

    // 9. Count output tokens
    const outputTokens = await client.countTokens(
      accumulatedText +
        toolCalls.map((tc) => JSON.stringify(tc.input)).join(""),
      cancellationToken,
    );

    // 10. Build and return response
    const responseObj = {
      id: generateResponseId(),
      object: "response",
      status: "completed",
      created_at: Math.floor(Date.now() / 1000),
      model: requestBody.model,
      output,
      error: null,
      incomplete_details: null,
      usage: {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: outputTokens,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: inputTokens + outputTokens,
      },
      metadata: requestBody.metadata ?? {},
    };

    logger.info(
      `← /v1/responses | input: ${inputTokens} | output: ${outputTokens}`,
    );
    return c.json(responseObj);
  } catch (error) {
    // Error handling...
  }
});
```

## Edge Cases

### 1. Empty Input

```typescript
if (!input || (Array.isArray(input) && input.length === 0)) {
  // If instruction is provided, use it as the only input
  if (instruction) {
    return [vscode.LanguageModelChatMessage.User(instruction)];
  }
  // Otherwise, return error
  return c.json({
    error: {
      type: "invalid_request_error",
      message: "input is required when instruction is not provided",
      param: "input",
      code: "missing_required_parameter"
    }
  }, 400);
}
```

### 2. Mixed Input Types

The input array can contain multiple types. Process in order:

```typescript
const messages: vscode.LanguageModelChatMessage[] = [];

// First, add instruction if present
if (instruction) {
  messages.push(vscode.LanguageModelChatMessage.User(instruction));
}

// Then process input items
if (typeof input === "string") {
  messages.push(vscode.LanguageModelChatMessage.User(input));
} else {
  for (const item of input) {
    const converted = convertResponsesItemToVSCode(item);
    if (converted) {
      messages.push(converted);
    }
  }
}
```

### 3. Consecutive Same-Role Messages

VSCode LM may not handle consecutive messages of the same role well. Consider merging:

```typescript
// Option 1: Merge consecutive same-role messages
const mergedMessages = mergeConsecutiveSameRoleMessages(messages);

// Option 2: Let VSCode LM handle it (may cause issues)
// Just pass messages as-is
```

### 4. Function Call Without Arguments

```typescript
if (chunk instanceof vscode.LanguageModelToolCallPart) {
  const arguments = JSON.stringify(chunk.input ?? {});
  // Handle empty input as empty object
}
```

### 5. Very Long Responses

For very long responses, streaming is essential. Non-streaming may timeout:

```typescript
// Add timeout handling for non-streaming
const RESPONSE_TIMEOUT_MS = 300000; // 5 minutes

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error("Response timeout")), RESPONSE_TIMEOUT_MS);
});

const responsePromise = collectFullResponse(response.stream);
const result = await Promise.race([responsePromise, timeoutPromise]);
```

### 6. ItemReferenceParam Handling

The input can contain `item_reference` which references previous items:

```typescript
// item_reference is only useful with previous_response_id
// Since we don't support that, treat item_reference as an error
if (item.type === "item_reference") {
  logger.warn("item_reference is not supported without previous_response_id, skipping");
  return null;
}
```

### 7. Model ID Normalization

Use existing fuzzy matching logic:

```typescript
const { client, error: clientError } = await getChatModelClient(modelId);
// This already handles model ID normalization (e.g., gpt-4 -> appropriate VSCode model)
```

## Testing Considerations

### Unit Tests (`src/test/server/openaiResponses.test.ts`)

1. **Input conversion tests:**

   - String input
   - Array with EasyInputMessage
   - Array with full InputMessage
   - Mixed array with function_call and function_call_output
   - With instruction field
   - Empty input with instruction
   - Unsupported item types (item_reference)

2. **Tool conversion tests:**

   - Function tools
   - Mixed tools (function + unsupported)
   - Empty tools array
   - Tool choice mapping

3. **Output building tests:**

   - Text-only output
   - Function call output
   - Mixed text and function calls
   - Empty output

4. **ID generation tests:**
   - Response ID format
   - Message ID format
   - Uniqueness

### Integration Tests

1. **Non-streaming request:**

   - Simple text response
   - With function calls
   - Error handling

2. **Streaming request:**

   - Event sequence
   - Text delta events
   - Function call events
   - Completion event

3. **Error cases:**
   - Invalid model
   - Unsupported parameters
   - Server errors

## Logging

Follow existing patterns:

```typescript
logger.info(
  `→ /v1/responses | model: ${
    modelId === client.id ? modelId : `${modelId} → ${client.id}`
  } | input: ${inputTokenCount}`,
);

// On success
logger.info(
  `← /v1/responses | input: ${inputTokenCount} | output: ${outputTokenCount}`,
);

// On streaming success
logger.info(
  `← /v1/responses (stream) | input: ${inputTokenCount} | output: ${outputTokenCount}`,
);

// On error
logger.error("✕ /v1/responses |", error);
```

## OpenAPI Documentation

```typescript
const createResponseRoute = createRoute({
  method: "post",
  path: "/v1/responses",
  tags: ["OpenAI API"],
  summary: "Create a model response with OpenAI Responses API",
  description: `Create a model response using the OpenAI Responses API interface, powered by VSCode Language Models.

Note: This is a stateless implementation. The following features are not supported:
- previous_response_id / conversation (send full history in input)
- Specialized tools (file_search, web_search, code_interpreter, computer_use)
- Reasoning token output`,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z
            .object()
            .describe(
              "OpenAI Responses API request body. See https://platform.openai.com/docs/api-reference/responses/create",
            ),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object() },
        "text/event-stream": { schema: z.object() },
      },
      description: "Successfully created response",
    },
    400: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Bad request - invalid or unsupported parameters",
    },
    404: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Model not found",
    },
    500: {
      content: { "application/json": { schema: CommonResponseError } },
      description: "Internal server error",
    },
  },
});
```

## Implementation Priority

### Phase 1: Core Functionality

1. Input conversion (string, EasyInputMessage, InputMessage)
2. Non-streaming response
3. Basic output structure

### Phase 2: Tool Support

4. Function tool conversion
5. Function call output items
6. Tool choice handling

### Phase 3: Streaming

7. SSE event structure
8. Text delta events
9. Function call events
10. Lifecycle events

### Phase 4: Polish

11. Comprehensive error handling
12. Logging and diagnostics
13. Tests
14. Documentation

## References

- [OpenAI Responses API Reference](https://platform.openai.com/docs/api-reference/responses/create)
- [OpenAI Responses API Guide](https://platform.openai.com/docs/guides/responses-vs-chat-completions)
- [Existing Chat Completions Implementation](../src/server/routes/openaiRoutes.ts)
- [OpenAI Schemas](../src/server/schemas/openai.ts)

## Limitations Summary

This section summarizes all limitations due to Agent Maestro's stateless architecture and VSCode Language Model API constraints.

### Stateful Features (Not Supported)

| Feature                | Reason                          | Workaround                                      |
| ---------------------- | ------------------------------- | ----------------------------------------------- |
| `previous_response_id` | Agent Maestro is stateless      | Send full conversation history in `input` array |
| `conversation`         | Agent Maestro is stateless      | Send full conversation history in `input` array |
| `item_reference`       | Requires `previous_response_id` | Include full item content instead               |

### Specialized Tools (Not Supported)

| Tool Type              | Reason                                        |
| ---------------------- | --------------------------------------------- |
| `file_search`          | Requires OpenAI vector store infrastructure   |
| `web_search_preview`   | No VSCode LM equivalent                       |
| `code_interpreter`     | No VSCode LM equivalent                       |
| `computer_use_preview` | No VSCode LM equivalent                       |
| `image_gen`            | No VSCode LM equivalent                       |
| `local_shell`          | Security concerns                             |
| `mcp`                  | Would require separate MCP server integration |

Only `function` type tools are supported.

### Input Content Limitations

| Content Type                    | Status                                |
| ------------------------------- | ------------------------------------- |
| `input_text`                    | Fully supported                       |
| `output_text`                   | Fully supported                       |
| `refusal`                       | Fully supported                       |
| `input_image` (base64 data URI) | Supported via `LanguageModelDataPart` |
| `input_image` (URL)             | Not supported (fallback to JSON text) |
| `input_file`                    | Not supported (fallback to JSON text) |

### Response Limitations

| Field                                    | Limitation                                                 |
| ---------------------------------------- | ---------------------------------------------------------- |
| `annotations` in `output_text`           | Always empty array (VSCode LM doesn't provide annotations) |
| `output_tokens_details.reasoning_tokens` | Always 0 (VSCode LM doesn't expose reasoning tokens)       |
| `ReasoningItem` in output                | Never generated (VSCode LM doesn't expose reasoning)       |

### Ignored Parameters

These parameters are accepted but have no effect:

| Parameter                    | Notes                                      |
| ---------------------------- | ------------------------------------------ |
| `store`                      | No storage capability                      |
| `include`                    | No additional data to include              |
| `background`                 | No background execution support            |
| `prompt_cache_key`           | No prompt caching support                  |
| `service_tier`               | No service tier differentiation            |
| `reasoning.effort`           | Passed through but may not affect behavior |
| `reasoning.generate_summary` | No reasoning token access                  |
