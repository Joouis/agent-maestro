# Gemini Routes Design

## Overview

The Gemini routes will follow the same pattern as Anthropic and OpenAI routes, providing a pass-through API that converts between Gemini's API format and VSCode Language Model API.

## Key Endpoints

### 1. POST /v1beta/models/{model}:generateContent

- **Purpose**: Non-streaming content generation
- **Input**: `GenerateContentParameters` from `@google/genai`
- **Output**: `GenerateContentResponse` with candidates, usage metadata
- **Features**:
  - Convert Gemini `Content[]` to VSCode `LanguageModelChatMessage[]`
  - Support system instructions via `systemInstruction` field
  - Handle function calling via `tools` and `functionCallingConfig`
  - Token counting for usage metadata

### 2. POST /v1beta/models/{model}:streamGenerateContent

- **Purpose**: Streaming content generation
- **Input**: Same as generateContent
- **Output**: Server-Sent Events stream of `GenerateContentResponse` chunks
- **Features**:
  - Real-time streaming via SSE
  - Incremental token counting
  - Progressive candidate updates

### 3. POST /v1beta/models/{model}:countTokens

- **Purpose**: Count tokens without generation
- **Input**: `CountTokensParameters`
- **Output**: `CountTokensResponse` with totalTokens
- **Features**:
  - Pre-flight token estimation
  - Support for cached content token counting

## Data Structure Mappings

### Content Conversion: Gemini → VSCode

**Gemini Structure:**

```typescript
interface Content {
  parts?: Part[]; // Array of text, functionCall, functionResponse, etc.
  role?: string; // "user" or "model"
}

interface Part {
  text?: string;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: Blob;
  fileData?: FileData;
  thought?: boolean;
}
```

**VSCode Structure:**

```typescript
vscode.LanguageModelChatMessage.User(parts);
vscode.LanguageModelChatMessage.Assistant(parts);
// Parts: LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart
```

**Mapping Logic:**

- `Content.role === "user"` → `LanguageModelChatMessage.User()`
- `Content.role === "model"` → `LanguageModelChatMessage.Assistant()`
- `Part.text` → `LanguageModelTextPart(text)`
- `Part.text + Part.thought === true` → Keep as text (thought tracking)
- `Part.functionCall` → `LanguageModelToolCallPart(id, name, args)`
- `Part.functionResponse` → `LanguageModelToolResultPart(id, [response])`
- `Part.inlineData` / `Part.fileData` → Convert to text or `LanguageModelDataPart` if available

### Response Conversion: VSCode → Gemini

**VSCode Stream:**

```typescript
for await (const chunk of response.stream) {
  if (chunk instanceof vscode.LanguageModelTextPart) { ... }
  else if (chunk instanceof vscode.LanguageModelToolCallPart) { ... }
}
```

**Gemini Response:**

```typescript
{
  candidates: [{
    content: {
      parts: [
        { text: "..." },
        { functionCall: { id, name, args } }
      ],
      role: "model"
    },
    finishReason: "STOP" | "MAX_TOKENS" | "FUNCTION_CALL",
  }],
  usageMetadata: {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount
  }
}
```

## Shared Logic Pattern

Following the pattern from `anthropicRoutes.ts`, the Gemini routes will use shared helper functions to avoid code duplication across endpoints.

### Shared Helper Functions (in `geminiRoutes.ts`)

#### 1. `prepareGeminiRequest()`

**Purpose**: Convert Gemini request to VSCode format and count input tokens
**Used by**: Both `generateContent` and `countTokens` endpoints

```typescript
const prepareGeminiRequest = async ({
  requestBody,
  client,
}: {
  requestBody: any; // GenerateContentParameters-like
  client: vscode.LanguageModelChat;
}) => {
  const { systemInstruction, contents, tools, generationConfig } = requestBody;

  // Convert to VSCode messages
  const vsCodeLmMessages: vscode.LanguageModelChatMessage[] = [
    ...convertGeminiSystemInstructionToVSCode(systemInstruction),
    ...convertGeminiContentsToVSCode(contents),
  ];

  // Count input tokens
  let inputTokenCount = 0;
  const cancellationToken = new vscode.CancellationTokenSource().token;
  for (const msg of vsCodeLmMessages) {
    inputTokenCount += await client.countTokens(msg, cancellationToken);
  }

  // Build request options
  const lmRequestOptions: vscode.LanguageModelChatRequestOptions = {
    justification:
      "Gemini-compatible API endpoint using VS Code Language Model API",
    modelOptions: generationConfig,
    tools: convertGeminiToolsToVSCode(tools),
    toolMode: convertGeminiToolConfigToVSCode(generationConfig?.toolConfig),
  };

  return {
    vsCodeLmMessages,
    inputTokenCount,
    cancellationToken,
    lmRequestOptions,
  };
};
```

#### 2. `processVSCodeStreamToGeminiParts()`

**Purpose**: Convert VSCode response stream to Gemini Part[] format
**Used by**: Both streaming and non-streaming `generateContent`

```typescript
const processVSCodeStreamToGeminiParts = async (
  stream: AsyncIterable<
    | vscode.LanguageModelChatResponseTextPart
    | vscode.LanguageModelChatResponseToolCallPart
  >,
) => {
  const parts: Part[] = [];
  let accumulatedText = "";

  for await (const chunk of stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      // Accumulate text in last text part or create new one
      let lastPart = parts.at(-1);
      if (!lastPart || !("text" in lastPart)) {
        lastPart = { text: "" };
        parts.push(lastPart);
      }
      lastPart.text += chunk.value;
      accumulatedText += chunk.value;
    } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
      parts.push({
        functionCall: {
          id: chunk.callId,
          name: chunk.name,
          args: chunk.input,
        },
      });
      accumulatedText += JSON.stringify(chunk);
    }
  }

  return { parts, accumulatedText };
};
```

### What's Shared vs Endpoint-Specific

| Component               | generateContent                                | streamGenerateContent              | countTokens                        |
| ----------------------- | ---------------------------------------------- | ---------------------------------- | ---------------------------------- |
| **Client retrieval**    | ✅ Shared                                      | ✅ Shared                          | ✅ Shared                          |
| **Request preparation** | ✅ Shared (`prepareGeminiRequest`)             | ✅ Shared (`prepareGeminiRequest`) | ✅ Shared (`prepareGeminiRequest`) |
| **VSCode LM request**   | ✅ Shared                                      | ✅ Shared                          | ❌ Not needed                      |
| **Stream processing**   | ✅ Shared (`processVSCodeStreamToGeminiParts`) | ✅ Shared (but pipes to SSE)       | ❌ Not needed                      |
| **Response format**     | ❌ Full JSON response                          | ❌ SSE stream                      | ❌ Token count only                |
| **Token counting**      | ✅ Input + Output                              | ✅ Input + Output                  | ✅ Input only                      |

### Route Handler Pattern

```typescript
export function registerGeminiRoutes(app: OpenAPIHono) {
  // POST /v1beta/models/{model}:generateContent
  app.openapi(generateContentRoute, async (c: Context): Promise<Response> => {
    const { client } = await getChatModelClient(modelId);           // SHARED
    const prepared = await prepareGeminiRequest({...});              // SHARED
    const response = await client.sendRequest(...);                  // SHARED

    if (!isStreaming) {
      const { parts } = await processVSCodeStreamToGeminiParts(...); // SHARED
      return c.json({ candidates: [{ content: { parts } }] });       // SPECIFIC
    }

    return streamSSE(c, async (stream) => { ... });                  // SPECIFIC
  });

  // POST /v1beta/models/{model}:countTokens
  app.openapi(countTokensRoute, async (c: Context) => {
    const { client } = await getChatModelClient(modelId);           // SHARED
    const { inputTokenCount } = await prepareGeminiRequest({...});  // SHARED
    return c.json({ totalTokens: inputTokenCount });                // SPECIFIC
  });
}
```

This pattern mirrors `anthropicRoutes.ts` where `prepareAnthropicMessages()` is the key shared helper.

## File Structure

### Files to Create:

#### 1. `src/server/routes/geminiRoutes.ts`

- Main route handlers
- OpenAPI route definitions
- Request/response orchestration
- **Shared helper functions** (like `prepareGeminiRequest`)
- Similar structure to `anthropicRoutes.ts`

#### 2. `src/server/utils/gemini.ts`

- Low-level conversion functions for Content/Part structures
- Functions:
  - `convertGeminiContentsToVSCode(contents: Content[]): LanguageModelChatMessage[]`
  - `convertGeminiContentToVSCode(content: Content): LanguageModelChatMessage`
  - `convertGeminiPartToVSCodePart(part: Part): LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelToolResultPart`
  - `convertGeminiSystemInstructionToVSCode(instruction?: ContentUnion): LanguageModelChatMessage[]`
  - `convertGeminiToolsToVSCode(tools?: Tool[]): LanguageModelChatTool[]`
  - `convertGeminiToolConfigToVSCode(config?: FunctionCallingConfig): LanguageModelChatToolMode`

#### 3. `src/server/schemas/gemini.ts`

- Error response schema
- Similar to `AnthropicErrorResponseSchema`
- Skip request/response body schemas (use `z.object()` like Anthropic/OpenAI)

### Integration:

#### Update `src/server/ProxyServer.ts`:

```typescript
import { registerGeminiRoutes } from "./routes/geminiRoutes";

// In constructor, add:
// Gemini-compatible API endpoint
this.app.route("/api/gemini", this.getApiGeminiRoutes());

// Add method:
private getApiGeminiRoutes(): OpenAPIHono {
  const routes = new OpenAPIHono();
  registerGeminiRoutes(routes);
  return routes;
}

// Add to OpenAPI tags:
{
  name: "Google Gemini API",
  description: "Gemini-compatible API endpoints using VSCode Language Models",
}
```

## Key Design Decisions

### 1. Skip Schema Validation (Like Anthropic/OpenAI routes)

```typescript
schema: z.object().describe(
  "Gemini API request body. See https://ai.google.dev/api/generate-content for schema details.",
);
```

**Rationale**: Allows flexibility as Google updates the API without requiring SDK updates

### 2. Model Selection Logic

- No Claude-specific model selection logic needed
- Directly use `model` parameter from request
- Get client via `getChatModelClient(modelId)`

### 3. System Instruction Handling

```typescript
// Gemini has dedicated systemInstruction field
const { systemInstruction, contents, tools, ...config } = requestBody;

const vsCodeMessages = [
  ...convertGeminiSystemInstructionToVSCode(systemInstruction),
  ...convertGeminiContentsToVSCode(contents),
];
```

### 4. Function Calling Mapping

**Gemini → VSCode:**

- `FunctionCallingConfig.mode === "AUTO"` → `LanguageModelChatToolMode.Auto`
- `FunctionCallingConfig.mode === "ANY"` → `LanguageModelChatToolMode.Required`
- `FunctionCallingConfig.mode === "NONE"` → `undefined` (no tools)

**VSCode → Gemini:**

- `LanguageModelTextPart` → `{ text: chunk.value }`
- `LanguageModelToolCallPart` → `{ functionCall: { id, name, args } }`

### 5. Streaming Response Format

Unlike Anthropic (which uses complex event types), Gemini streaming is simpler:

```typescript
// Each chunk is a complete GenerateContentResponse
data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}],"usageMetadata":{...}}
data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"}}],"usageMetadata":{...}}
```

### 6. Error Handling

```typescript
// Gemini error format
{
  error: {
    code: 400,
    message: "Invalid argument",
    status: "INVALID_ARGUMENT"
  }
}
```

## Testing Considerations

1. **Non-streaming generation**: Text-only responses
2. **Streaming generation**: Progressive text chunks
3. **Function calling**: Tool use and tool results
4. **Token counting**: Pre-flight estimation
5. **System instructions**: Proper conversion to User messages
6. **Multi-part content**: Mixed text + function calls
7. **Thought parts**: Special handling for `thought: true`

## OpenAPI Documentation

Routes will be properly documented with:

- Summary and description
- Request/response content types
- Example use cases
- Links to official Gemini API docs
- Tags: `["Google Gemini API", "pass-through"]`

## Differences from Anthropic/OpenAI Routes

| Feature               | Anthropic                | OpenAI                      | Gemini                               |
| --------------------- | ------------------------ | --------------------------- | ------------------------------------ |
| **API Prefix**        | `/api/anthropic`         | `/api/openai`               | `/api/gemini`                        |
| **System prompt**     | Separate `system` field  | Part of messages array      | Dedicated `systemInstruction` field  |
| **Role names**        | `user`/`assistant`       | `user`/`assistant`/`system` | `user`/`model`                       |
| **Function calling**  | `tool_use`/`tool_result` | `tool_calls`/`tool`         | `functionCall`/`functionResponse`    |
| **Streaming format**  | Complex SSE events       | Simple SSE with deltas      | Simple SSE with full chunks          |
| **Token counting**    | Separate endpoint        | No dedicated endpoint       | Dedicated `:countTokens` endpoint    |
| **Content structure** | Flat array of blocks     | Message-based               | Hierarchical `Content` with `Part[]` |

## Benefits of This Design

1. **Consistency**: Follows established patterns from Anthropic/OpenAI routes
2. **Flexibility**: Schema-less validation allows API evolution
3. **Completeness**: Supports all key Gemini features (streaming, tools, token counting)
4. **Maintainability**: Clear separation of concerns (routes, utils, schemas)
5. **Extensibility**: Easy to add more endpoints (embedContent, cachedContents, etc.) later

## Future Enhancements

Potential endpoints to add later:

- **POST /v1beta/models/{model}:embedContent** - Text embeddings
- **POST /v1beta/cachedContents** - Create cached content
- **GET /v1beta/cachedContents/{name}** - Get cached content
- **DELETE /v1beta/cachedContents/{name}** - Delete cached content
- **GET /v1beta/models** - List available models

## References

- [Gemini API Documentation](https://ai.google.dev/api)
- [Gemini Generate Content](https://ai.google.dev/api/generate-content)
- [@google/genai Package](https://www.npmjs.com/package/@google/genai)
