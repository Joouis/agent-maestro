import { z } from "@hono/zod-openapi";

export const AnthropicErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string().describe("Error message"),
      type: z.string().describe("Error type"),
    }),
    type: z.string().describe("Error type"),
  })
  .openapi("AnthropicErrorResponse");

export const AnthropicMessageCreateParamsSchema = z.looseObject({
  model: z.string().describe("The model to use for the request"),
  messages: z
    .array(
      z.looseObject({
        role: z
          .enum(["user", "assistant"])
          .describe("The role of the message sender"),
        content: z
          .union([
            z.string(),
            z.array(
              z.union([
                z.looseObject({
                  type: z.literal("text"),
                  text: z.string(),
                }),
                z.looseObject({
                  type: z.literal("image"),
                  source: z.looseObject({
                    type: z.literal("base64"),
                    media_type: z.string(),
                    data: z.string(),
                  }),
                }),
                z.looseObject({
                  type: z.literal("tool_use"),
                  id: z.string(),
                  name: z.string(),
                  input: z.looseObject({}),
                }),
                z.looseObject({
                  type: z.literal("tool_result"),
                  tool_use_id: z.string(),
                  content: z.union([z.string(), z.array(z.any())]).optional(),
                  is_error: z.boolean().optional(),
                }),
              ]),
            ),
          ])
          .describe("The content of the message"),
      }),
    )
    .describe("Array of conversation messages"),
  system: z
    .union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.literal("text"),
          text: z.string(),
          cache_control: z
            .looseObject({
              type: z.literal("ephemeral"),
            })
            .optional(),
        }),
      ),
    ])
    .optional()
    .describe("System message to guide the assistant"),
  max_tokens: z
    .number()
    .min(1)
    .optional()
    .describe("Maximum number of tokens to generate"),
  metadata: z
    .looseObject({
      user_id: z.string().optional(),
    })
    .optional()
    .describe("Metadata for the request"),
  stop_sequences: z
    .array(z.string())
    .optional()
    .describe(
      "Custom text sequences that will cause the model to stop generating",
    ),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Controls randomness in responses (0.0 to 1.0)"),
  top_k: z
    .number()
    .min(1)
    .optional()
    .describe("Only sample from the top K options for each subsequent token"),
  top_p: z.number().min(0).max(1).optional().describe("Use nucleus sampling"),
  stream: z.boolean().optional().describe("Whether to stream the response"),
  tools: z
    .array(
      z.looseObject({
        name: z.string().describe("The name of the tool"),
        description: z
          .string()
          .optional()
          .describe("Description of what the tool does"),
        input_schema: z
          .record(z.string(), z.any())
          // "web_search" tool does not meet the schema, so we make it optional
          .optional()
          .describe("JSON schema for the tool input"),
        cache_control: z
          .looseObject({
            type: z.literal("ephemeral"),
          })
          .optional(),
      }),
    )
    .optional()
    .describe("Available tools for the model"),
  tool_choice: z
    .union([
      z.looseObject({
        type: z.literal("auto"),
      }),
      z.looseObject({
        type: z.literal("any"),
      }),
      z.looseObject({
        type: z.literal("tool"),
        name: z.string(),
      }),
    ])
    .optional()
    .describe("Tool choice configuration"),
});

export const AnthropicMessageResponseSchema = z.looseObject({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(z.any()),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z.looseObject({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().nullable(),
    cache_read_input_tokens: z.number().nullable(),
    server_tool_use: z.any().nullable(),
    service_tier: z.string().nullable(),
  }),
});

export const AnthropicCountTokensResponseSchema = z.object({
  input_tokens: z.number().describe("Number of input tokens"),
});
