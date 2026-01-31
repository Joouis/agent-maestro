# OpenAI Responses API Design

## Overview

The OpenAI Responses API (`POST /v1/responses`) is a newer API that provides a different interface from the Chat Completions API. This document outlines the design decisions for supporting this API in Agent Maestro.

## API Comparison: Chat Completions vs Responses

| Aspect               | Chat Completions (`/chat/completions`)        | Responses (`/v1/responses`)                                            |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| **Input format**     | `messages` array with role/content            | `input` (string or array of items)                                     |
| **System prompt**    | `system` role in messages or `developer` role | Dedicated `instructions` field                                         |
| **Response format**  | `choices[].message`                           | `output` array of items                                                |
| **Tool calls**       | In `choices[].message.tool_calls`             | Separate `function_call` items in `output`                             |
| **Streaming events** | `chat.completion.chunk` object                | Fine-grained events (e.g., `response.output_text.delta`)               |
| **Multi-turn**       | Manual message history management             | `previous_response_id` / `conversation`                                |
| **Reasoning**        | Not supported                                 | `reasoning` object with effort/summary                                 |
| **Tool types**       | Function tools only                           | Function, file_search, web_search, computer_use, code_interpreter, mcp |

## Architecture

### Request Flow

1. **Validate request** - Check for unsupported stateful parameters, validate required fields
2. **Get model client** - Use existing model resolution and VSCode LM client
3. **Convert input** - Transform Responses API input format to VSCode `LanguageModelChatMessage[]`
4. **Convert tools** - Filter to function tools only (unsupported tools are skipped)
5. **Send request** - Call VSCode Language Model API
6. **Convert output** - Transform VSCode response to Responses API output format
7. **Handle streaming** - Emit fine-grained SSE events for streaming mode

### File Structure

| File                                         | Purpose                                    |
| -------------------------------------------- | ------------------------------------------ |
| `src/server/routes/openaiResponsesRoutes.ts` | Route handler for `/v1/responses` endpoint |
| `src/server/utils/openaiResponses.ts`        | Conversion utilities and ID generation     |
| `src/test/server/openaiResponses.test.ts`    | Unit tests for conversion functions        |

## Data Mapping

### Input Conversion (Responses API → VSCode)

| Responses API Input                    | VSCode LM Output            |
| -------------------------------------- | --------------------------- |
| `input: string`                        | User message with text part |
| `instructions: string`                 | User message (prepended)    |
| `{role: "user", content: ...}`         | User message                |
| `{role: "assistant", content: ...}`    | Assistant message           |
| `{role: "system" \| "developer", ...}` | User message                |
| `{type: "function_call", ...}`         | Assistant with tool call    |
| `{type: "function_call_output", ...}`  | User with tool result       |

### Content Type Handling

| Content Type  | Handling                                                  |
| ------------- | --------------------------------------------------------- |
| `input_text`  | Convert to `LanguageModelTextPart`                        |
| `output_text` | Convert to `LanguageModelTextPart`                        |
| `input_image` | Base64 data URI → `LanguageModelDataPart`, URL → fallback |
| `input_file`  | Not supported, fallback to JSON text                      |

### Output Conversion (VSCode → Responses API)

| VSCode LM Part              | Responses API Output                |
| --------------------------- | ----------------------------------- |
| `LanguageModelTextPart`     | `{type: "message", content: [...]}` |
| `LanguageModelToolCallPart` | `{type: "function_call", ...}`      |

### Tool Choice Mapping

| Responses API        | VSCode LM                            |
| -------------------- | ------------------------------------ |
| `"none"`             | Don't pass tools                     |
| `"auto"`             | `LanguageModelChatToolMode.Auto`     |
| `"required"`         | `LanguageModelChatToolMode.Required` |
| `{type: "function"}` | `LanguageModelChatToolMode.Required` |

## Streaming Events

For `stream: true`, emit fine-grained events in this order:

1. **Lifecycle events**: `response.created` → `response.in_progress` → `response.completed`
2. **Output item events**: `response.output_item.added` → `response.output_item.done`
3. **Text events**: `response.content_part.added` → `response.output_text.delta` → `response.output_text.done`
4. **Function call events**: `response.function_call_arguments.delta` → `response.function_call_arguments.done`

## Limitations

### Stateless Architecture

Agent Maestro is stateless and doesn't persist responses between requests.

| Feature                | Status        | Workaround                                      |
| ---------------------- | ------------- | ----------------------------------------------- |
| `previous_response_id` | Not supported | Send full conversation history in `input` array |
| `conversation`         | Not supported | Send full conversation history in `input` array |
| `item_reference`       | Not supported | Include full item content instead               |

**Error Response**: Return 400 with clear explanation directing users to send full history.

### Unsupported Tools

Only `function` type tools are supported. Other tools are filtered out with a warning log.

| Tool Type              | Reason                                        |
| ---------------------- | --------------------------------------------- |
| `file_search`          | Requires OpenAI vector store infrastructure   |
| `web_search_preview`   | No VSCode LM equivalent                       |
| `code_interpreter`     | No VSCode LM equivalent                       |
| `computer_use_preview` | No VSCode LM equivalent                       |
| `image_gen`            | No VSCode LM equivalent                       |
| `local_shell`          | Security concerns                             |
| `mcp`                  | Would require separate MCP server integration |
| `custom`               | No VSCode LM equivalent for custom tool input |
| `shell`                | No VSCode LM equivalent                       |
| `apply_patch`          | No VSCode LM equivalent                       |

### Content Limitations

| Content Type    | Limitation                                                        |
| --------------- | ----------------------------------------------------------------- |
| `input_image`   | Only base64 data URI supported; URL-based images fallback to JSON |
| `input_file`    | Not supported, serialized as JSON text                            |
| `annotations`   | Always empty (VSCode LM doesn't provide annotations)              |
| Reasoning items | Never generated (VSCode LM doesn't expose reasoning)              |

### Ignored Parameters

These parameters are accepted but have no effect:

- `store`, `include`, `background`, `prompt_cache_key`, `service_tier`
- `reasoning.effort` (passed through but may not affect behavior)
- `reasoning.generate_summary` (no reasoning token access)

## ID Format

All generated IDs use the prefix `AM-` to identify Agent Maestro:

- Response ID: `resp_AM-{timestamp}-{random}`
- Message ID: `msg_AM-{random}`
- Function call ID: `fc_AM-{random}`
- Call ID: `call_AM-{random}`

## Error Handling

- **Validation errors**: Return 400 with structured error object
- **Model not found**: Return 404
- **Server errors**: Return 500, log error details for debugging
- **Streaming errors**: Emit `response.failed` event

## References

- [OpenAI Responses API Reference](https://platform.openai.com/docs/api-reference/responses/create)
- [OpenAI Responses vs Chat Completions Guide](https://platform.openai.com/docs/guides/responses-vs-chat-completions)
