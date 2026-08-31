import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import { LanguageModelRequestLifecycle } from "../../server/utils/languageModelRequestLifecycle";
import {
  OpenAIResponsesRequestValidationError,
  PreparedOpenAIResponsesTools,
  isImmediateResponsesToolContinuation,
  prepareOpenAIResponsesTools,
  runOpenAIResponsesWebSearchLoop,
} from "../../server/utils/openaiResponsesWebSearch";
import { WebSearchProvider } from "../../server/webSearch/webSearchProvider";

type ModelChunk =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelDataPart;

interface MockRound {
  chunks: ModelChunk[];
  error?: Error;
}

const usagePart = ({
  input = 10,
  output = 2,
  cached = 0,
  reasoning = 0,
}: {
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
} = {}) =>
  new vscode.LanguageModelDataPart(
    new TextEncoder().encode(
      JSON.stringify({
        prompt_tokens: input,
        completion_tokens: output,
        prompt_tokens_details: { cached_tokens: cached },
        completion_tokens_details: { reasoning_tokens: reasoning },
      }),
    ),
    "usage",
  );

const createRoundModel = (
  rounds: MockRound[],
  requests: Array<{
    messages: readonly vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }>,
  countTokens: (text: string) => number = () => 1,
): vscode.LanguageModelChat =>
  ({
    id: "gpt-5.6-test",
    name: "GPT 5.6 Test",
    family: "gpt-5.6",
    version: "test",
    vendor: "copilot",
    maxInputTokens: 200_000,
    capabilities: {
      supportsImageToText: false,
      supportsToolCalling: true,
    },
    sendRequest: async (messages, options) => {
      requests.push({ messages, options: options ?? {} });
      const round = rounds.shift();
      if (!round) {
        throw new Error("Unexpected model round");
      }
      return {
        stream: (async function* () {
          for (const chunk of round.chunks) {
            yield chunk;
          }
          if (round.error) {
            throw round.error;
          }
        })(),
        text: (async function* () {})(),
      };
    },
    countTokens: async (value) =>
      countTokens(typeof value === "string" ? value : JSON.stringify(value)),
  }) as vscode.LanguageModelChat;

const webSearchTool = (overrides: Record<string, unknown> = {}) => ({
  type: "web_search",
  ...overrides,
});

const clientTool = (name = "get_weather") => ({
  type: "function",
  name,
  description: "Client tool",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
  },
});

const prepareSearch = ({
  tools = [webSearchTool()],
  toolChoice = "auto",
  input = "Search",
  include,
  maxOutputTokens,
  maxToolCalls,
  parallelToolCalls,
  available = true,
}: {
  tools?: unknown[];
  toolChoice?: unknown;
  input?: unknown;
  include?: unknown;
  maxOutputTokens?: unknown;
  maxToolCalls?: unknown;
  parallelToolCalls?: unknown;
  available?: boolean;
} = {}) =>
  prepareOpenAIResponsesTools({
    tools,
    toolChoice,
    input,
    include,
    maxOutputTokens,
    maxToolCalls,
    parallelToolCalls,
    serverWebSearchAvailable: available,
  });

const internalCall = (
  prepared: PreparedOpenAIResponsesTools,
  callId = "search-1",
  input: object = { query: "latest Miami International game result" },
) =>
  new vscode.LanguageModelToolCallPart(
    callId,
    prepared.internalWebSearchToolName!,
    input,
  );

const createProvider = (
  search: WebSearchProvider["search"],
): WebSearchProvider => ({ search });

const runLoop = async ({
  rounds,
  prepared = prepareSearch(),
  provider,
  maxOutputTokens,
  requests = [],
  countTokens,
}: {
  rounds: MockRound[];
  prepared?: PreparedOpenAIResponsesTools;
  provider: WebSearchProvider;
  maxOutputTokens?: number;
  requests?: Array<{
    messages: readonly vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }>;
  countTokens?: (text: string) => number;
}) => {
  const lifecycle = new LanguageModelRequestLifecycle(
    new AbortController().signal,
    1_000,
  );
  try {
    return await runOpenAIResponsesWebSearchLoop({
      client: createRoundModel(rounds, requests, countTokens),
      messages: [vscode.LanguageModelChatMessage.User("Search")],
      baseRequestOptions: {
        justification: "test",
        tools: prepared.tools,
        toolMode: prepared.toolMode,
      },
      preparedTools: prepared,
      provider,
      lifecycle,
      maxOutputTokens,
      providerTimeoutMs: 100,
    });
  } finally {
    lifecycle.dispose();
  }
};

const createTestApp = ({
  rounds,
  provider,
  requests = [],
  countTokens,
  onResolve,
}: {
  rounds: MockRound[];
  provider?: WebSearchProvider;
  requests?: Array<{
    messages: readonly vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }>;
  countTokens?: (text: string) => number;
  onResolve?: () => void;
}) => {
  const app = new OpenAPIHono();
  const model = createRoundModel(rounds, requests, countTokens);
  registerOpenaiResponsesRoutes(app, {
    heartbeatIntervalMs: 5,
    providerTimeoutMs: 100,
    requestTimeoutMs: 1_000,
    resolveChatModelClient: async () => {
      onResolve?.();
      return { client: model };
    },
    webSearchProvider: provider,
  });
  return app;
};

const parseSseData = (body: string): Record<string, any>[] =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));

suite("OpenAI Responses Server Web Search Test Suite", () => {
  suite("classification and validation", () => {
    test("exposes the private tool with decision guidance and query description", () => {
      const prepared = prepareSearch();
      const tool = prepared.tools?.[0];
      const schema = tool?.inputSchema as Record<string, any>;

      assert.strictEqual(prepared.usesWebSearchLoop, true);
      assert.strictEqual(tool?.name, "agent_maestro_web_search");
      assert.match(tool?.description ?? "", /Use for recent events/);
      assert.match(tool?.description ?? "", /untrusted evidence/);
      assert.strictEqual(
        schema.properties.query.description,
        "A focused public-web search query containing only the information needed.",
      );
    });

    test("avoids client tool name collisions without intercepting the client tool", () => {
      const prepared = prepareSearch({
        tools: [webSearchTool(), clientTool("agent_maestro_web_search")],
      });

      assert.deepStrictEqual(
        prepared.tools?.map(({ name }) => name),
        ["agent_maestro_web_search", "agent_maestro_web_search_"],
      );
      assert.strictEqual(
        prepared.internalWebSearchToolName,
        "agent_maestro_web_search_",
      );
    });

    test("normalizes filters, location, context size, includes, and nullable fields", () => {
      const prepared = prepareSearch({
        tools: [
          webSearchTool({
            search_context_size: "low",
            filters: {
              allowed_domains: ["Example.COM", "example.com"],
              blocked_domains: null,
            },
            user_location: {
              type: "approximate",
              country: "us",
              city: null,
              region: null,
              timezone: null,
            },
            external_web_access: true,
            return_token_budget: "default",
            search_content_types: ["text"],
          }),
        ],
        include: ["web_search_call.action.sources"],
        maxOutputTokens: null,
        maxToolCalls: null,
        parallelToolCalls: null,
      });

      assert.deepStrictEqual(prepared.webSearch, {
        maxResults: 3,
        allowedDomains: ["example.com"],
        userLocation: { country: "US" },
        includeSources: true,
      });
    });

    test("accepts an omitted user_location type", () => {
      const prepared = prepareSearch({
        tools: [
          webSearchTool({
            user_location: { country: "US" },
          }),
        ],
      });

      assert.deepStrictEqual(prepared.webSearch?.userLocation, {
        country: "US",
      });
    });

    test("maps medium, high, and omitted context sizes to five results", () => {
      for (const size of [undefined, "medium", "high"]) {
        const prepared = prepareSearch({
          tools: [
            webSearchTool({ ...(size && { search_context_size: size }) }),
          ],
        });
        assert.strictEqual(prepared.webSearch?.maxResults, 5);
      }
    });

    test("rejects duplicate, preview, malformed, and unsupported search options", () => {
      const invalidCases: unknown[][] = [
        [webSearchTool(), webSearchTool({ type: "web_search_2025_08_26" })],
        [{ type: "web_search_preview" }],
        [webSearchTool({ search_context_size: null })],
        [
          webSearchTool({
            filters: { allowed_domains: ["https://example.com"] },
          }),
        ],
        [
          webSearchTool({
            filters: { allowed_domains: new Array(101).fill("example.com") },
          }),
        ],
        [webSearchTool({ user_location: { type: null } })],
        [
          webSearchTool({
            user_location: { type: "approximate", country: "ZZ" },
          }),
        ],
        [
          webSearchTool({
            user_location: { type: "approximate", city: "Miami" },
          }),
        ],
        [webSearchTool({ external_web_access: false })],
        [webSearchTool({ external_web_access: null })],
        [webSearchTool({ return_token_budget: "unlimited" })],
        [webSearchTool({ search_content_types: ["image"] })],
        [webSearchTool({ search_content_types: null })],
        [webSearchTool({ image_settings: null })],
        [webSearchTool({ unknown_option: true })],
      ];

      for (const tools of invalidCases) {
        assert.throws(
          () => prepareSearch({ tools }),
          OpenAIResponsesRequestValidationError,
        );
      }
    });

    test("reports complete parameter paths for unknown search fields", () => {
      const cases: Array<{
        expectedParam: string;
        tools: unknown[];
      }> = [
        {
          tools: [webSearchTool({ unknown_option: true })],
          expectedParam: "tools.unknown_option",
        },
        {
          tools: [
            webSearchTool({
              filters: { unknown_option: true },
            }),
          ],
          expectedParam: "tools.filters.unknown_option",
        },
        {
          tools: [
            webSearchTool({
              user_location: {
                type: "approximate",
                unknown_option: true,
              },
            }),
          ],
          expectedParam: "tools.user_location.unknown_option",
        },
      ];

      for (const { tools, expectedParam } of cases) {
        assert.throws(
          () => prepareSearch({ tools }),
          (error: unknown) =>
            error instanceof OpenAIResponsesRequestValidationError &&
            error.param === expectedParam,
        );
      }
    });

    test("rejects invalid budgets, allowed_tools, and raw results", () => {
      const cases = [
        () => prepareSearch({ maxToolCalls: 0 }),
        () => prepareSearch({ maxOutputTokens: 0 }),
        () =>
          prepareSearch({
            toolChoice: { type: "allowed_tools", tools: [] },
          }),
        () => prepareSearch({ include: ["web_search_call.results"] }),
      ];

      for (const invoke of cases) {
        assert.throws(invoke, OpenAIResponsesRequestValidationError);
      }
    });

    test("rejects unknown web-search-specific include values", () => {
      assert.throws(
        () => prepareSearch({ include: ["web_search_call.unknown"] }),
        (error: unknown) =>
          error instanceof OpenAIResponsesRequestValidationError &&
          error.param === "include",
      );
    });

    test("accepts parallel_tool_calls false while enforcing one server dispatch", () => {
      const prepared = prepareSearch({ parallelToolCalls: false });
      assert.strictEqual(prepared.usesWebSearchLoop, true);
      assert.strictEqual(prepared.tools?.length, 1);
    });

    test("rejects non-boolean parallel_tool_calls values", () => {
      for (const parallelToolCalls of ["false", 0, {}]) {
        assert.throws(
          () => prepareSearch({ parallelToolCalls }),
          (error: unknown) =>
            error instanceof OpenAIResponsesRequestValidationError &&
            error.param === "parallel_tool_calls",
        );
      }
    });

    test("does not reject search-only includes when tool_choice disables the loop", () => {
      const prepared = prepareSearch({
        toolChoice: "none",
        include: ["web_search_call.results"],
        parallelToolCalls: false,
      });

      assert.strictEqual(prepared.usesWebSearchLoop, false);
      assert.strictEqual(prepared.tools, undefined);
    });
  });

  suite("tool choice and continuation isolation", () => {
    test("supports auto, none, required, forced search, and named client choices", () => {
      const tools = [webSearchTool(), clientTool()];
      const auto = prepareSearch({ tools, toolChoice: "auto" });
      assert.strictEqual(auto.tools?.length, 2);
      assert.strictEqual(auto.toolMode, vscode.LanguageModelChatToolMode.Auto);

      const none = prepareSearch({ tools, toolChoice: "none" });
      assert.strictEqual(none.tools, undefined);
      assert.strictEqual(none.usesWebSearchLoop, false);

      const required = prepareSearch({ tools, toolChoice: "required" });
      assert.strictEqual(required.tools?.length, 2);
      assert.strictEqual(
        required.toolMode,
        vscode.LanguageModelChatToolMode.Required,
      );

      for (const type of ["web_search", "web_search_2025_08_26"]) {
        const forced = prepareSearch({ tools, toolChoice: { type } });
        assert.deepStrictEqual(
          forced.tools?.map(({ name }) => name),
          [forced.internalWebSearchToolName],
        );
        assert.strictEqual(
          forced.toolMode,
          vscode.LanguageModelChatToolMode.Required,
        );
      }

      const named = prepareSearch({
        tools,
        toolChoice: { type: "function", name: "get_weather" },
      });
      assert.deepStrictEqual(
        named.tools?.map(({ name }) => name),
        ["get_weather"],
      );
      assert.strictEqual(named.usesWebSearchLoop, false);
    });

    test("allows auto without a provider but rejects forced search", () => {
      const auto = prepareSearch({ available: false });
      assert.strictEqual(auto.usesWebSearchLoop, false);
      assert.strictEqual(auto.tools, undefined);

      assert.throws(
        () =>
          prepareSearch({
            available: false,
            toolChoice: { type: "web_search" },
          }),
        (error: unknown) =>
          error instanceof OpenAIResponsesRequestValidationError &&
          error.code === "tool_unavailable",
      );
    });

    test("returns tool_unavailable when required search is the only declared tool", () => {
      assert.throws(
        () =>
          prepareSearch({
            available: false,
            toolChoice: "required",
          }),
        (error: unknown) =>
          error instanceof OpenAIResponsesRequestValidationError &&
          error.code === "tool_unavailable",
      );
    });

    test("requires a declaration for a specific search choice", () => {
      assert.throws(
        () =>
          prepareSearch({
            tools: [clientTool()],
            toolChoice: { type: "web_search" },
          }),
        (error: unknown) =>
          error instanceof OpenAIResponsesRequestValidationError &&
          error.code === "tool_not_found",
      );
    });

    test("blocks immediate tool-result continuations including trailing metadata", () => {
      const input = [
        { type: "function_call_output", call_id: "call-1", output: "secret" },
        { type: "reasoning", summary: [] },
        { type: "additional_tools", tools: [clientTool()] },
      ];
      assert.strictEqual(isImmediateResponsesToolContinuation(input), true);
      assert.strictEqual(
        prepareSearch({ input, toolChoice: "auto" }).usesWebSearchLoop,
        false,
      );
      assert.throws(
        () =>
          prepareSearch({
            input,
            toolChoice: { type: "web_search" },
          }),
        (error: unknown) =>
          error instanceof OpenAIResponsesRequestValidationError &&
          error.code === "tool_unavailable",
      );
    });

    test("a later user message re-enables search", () => {
      const input = [
        { type: "function_call_output", call_id: "call-1", output: "result" },
        { role: "user", content: "Now search for current information" },
      ];
      assert.strictEqual(isImmediateResponsesToolContinuation(input), false);
      assert.strictEqual(prepareSearch({ input }).usesWebSearchLoop, true);
    });
  });

  suite("orchestration, isolation, citations, and budgets", () => {
    test("returns ordinary output without dispatch when the model does not select search", async () => {
      let providerCalls = 0;
      const result = await runLoop({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("No search needed."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          providerCalls++;
          return [];
        }),
      });

      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.webSearchRequests, 0);
      assert.strictEqual(result.output[0].type, "message");
      assert.doesNotMatch(
        JSON.stringify(result.output),
        /agent_maestro_web_search/,
      );
    });

    test("executes one search, isolates synthesis, and builds valid citations", async () => {
      const prepared = prepareSearch({
        include: ["web_search_call.action.sources"],
      });
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const providerRequests: unknown[] = [];
      const result = await runLoop({
        prepared,
        requests,
        rounds: [
          {
            chunks: [
              internalCall(prepared),
              usagePart({ input: 10, output: 2 }),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "Miami International won its latest game. https://example.com/game",
              ),
              usagePart({ input: 20, output: 5 }),
            ],
          },
        ],
        provider: createProvider(async (request) => {
          providerRequests.push(request);
          return [
            {
              title: "Miami International result",
              url: "https://example.com/game",
              snippet: "Miami International won 2-1.",
            },
          ];
        }),
      });

      assert.strictEqual(result.webSearchRequests, 1);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(requests[1].options.tools, undefined);
      assert.strictEqual(requests[1].options.toolMode, undefined);
      assert.strictEqual(providerRequests.length, 1);
      assert.strictEqual(result.usage.input_tokens, 30);
      assert.strictEqual(result.usage.output_tokens, 7);

      const search = result.output[0];
      assert.strictEqual(search.type, "web_search_call");
      assert.strictEqual(search.status, "completed");
      if (
        search.type === "web_search_call" &&
        search.action.type === "search"
      ) {
        assert.deepStrictEqual(search.action.queries, [
          "latest Miami International game result",
        ]);
        assert.deepStrictEqual(search.action.sources, [
          { type: "url", url: "https://example.com/game" },
        ]);
      }

      const message = result.output[1];
      assert.strictEqual(message.type, "message");
      if (message.type === "message") {
        const part = message.content[0];
        assert.strictEqual(part.type, "output_text");
        if (part.type === "output_text") {
          const citation = part.annotations[0] as any;
          assert.strictEqual(
            part.text.slice(citation.start_index, citation.end_index),
            citation.url,
          );
        }
      }
      const hiddenEvidence = requests[1].messages.at(-1)?.content[0] as any;
      assert.match(
        hiddenEvidence.content[0].value,
        /UNTRUSTED WEB SEARCH EVIDENCE/,
      );
    });

    test("appends uncited source URLs and counts them within the shared budget", async () => {
      const prepared = prepareSearch();
      const result = await runLoop({
        prepared,
        maxOutputTokens: 10,
        countTokens: () => 1,
        rounds: [
          { chunks: [internalCall(prepared), usagePart({ output: 2 })] },
          {
            chunks: [
              new vscode.LanguageModelTextPart("Miami International won."),
              usagePart({ output: 3 }),
            ],
          },
        ],
        provider: createProvider(async () => [
          { title: "Result", url: "https://example.com/latest" },
        ]),
      });
      const message = result.output[1];

      assert.strictEqual(result.incomplete, false);
      assert.strictEqual(result.usage.output_tokens, 6);
      assert.strictEqual(message.type, "message");
      if (
        message.type === "message" &&
        message.content[0].type === "output_text"
      ) {
        assert.match(
          message.content[0].text,
          /Sources:\n- https:\/\/example\.com\/latest/,
        );
      }
    });

    test("enforces the low context result cap after provider normalization", async () => {
      const prepared = prepareSearch({
        tools: [webSearchTool({ search_context_size: "low" })],
        include: ["web_search_call.action.sources"],
      });
      const result = await runLoop({
        prepared,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart("Bounded answer."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () =>
          Array.from({ length: 5 }, (_, index) => ({
            title: `Result ${index + 1}`,
            url: `https://example.com/${index + 1}`,
          })),
        ),
      });
      const search = result.output[0];

      assert.strictEqual(search.type, "web_search_call");
      if (
        search.type === "web_search_call" &&
        search.action.type === "search"
      ) {
        assert.strictEqual(search.action.sources?.length, 3);
      }
    });

    test("does not confuse a source URL with a longer URL that shares its prefix", async () => {
      const prepared = prepareSearch();
      const result = await runLoop({
        prepared,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "The result is at https://example.com/game",
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => [
          { title: "Homepage", url: "https://example.com/" },
          { title: "Game", url: "https://example.com/game" },
        ]),
      });
      const message = result.output[1];
      assert.strictEqual(message.type, "message");
      if (
        message.type === "message" &&
        message.content[0].type === "output_text"
      ) {
        const part = message.content[0];
        assert.match(part.text, /Sources:\n- https:\/\/example\.com\//);
        assert.deepStrictEqual(
          part.annotations.map((annotation: any) =>
            part.text.slice(annotation.start_index, annotation.end_index),
          ),
          ["https://example.com/game", "https://example.com/"],
        );
      }
    });

    test("does not cite a result URL prefix inside an unrelated URL", async () => {
      const prepared = prepareSearch();
      const result = await runLoop({
        prepared,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "Unrelated URL: https://example.com/unrelated",
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => [
          { title: "Homepage", url: "https://example.com/" },
        ]),
      });
      const message = result.output[1];
      assert.strictEqual(message.type, "message");
      if (
        message.type === "message" &&
        message.content[0].type === "output_text"
      ) {
        const part = message.content[0];
        assert.match(
          part.text,
          /https:\/\/example\.com\/unrelated\n\nSources:\n- https:\/\/example\.com\//,
        );
        assert.deepStrictEqual(
          part.annotations.map((annotation: any) =>
            part.text.slice(annotation.start_index, annotation.end_index),
          ),
          ["https://example.com/"],
        );
      }
    });

    test("cites exact source URLs containing parentheses and trailing punctuation", async () => {
      const prepared = prepareSearch();
      const sourceUrls = [
        "https://en.wikipedia.org/wiki/Function_(mathematics)",
        "https://example.com/article!",
        "https://example.com/search?q=what?",
      ];
      const result = await runLoop({
        prepared,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                `Sources: [Function](${sourceUrls[0]}), ${sourceUrls[1]}, and ${sourceUrls[2]}`,
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () =>
          sourceUrls.map((url, index) => ({
            title: `Source ${index + 1}`,
            url,
          })),
        ),
      });
      const message = result.output[1];
      assert.strictEqual(message.type, "message");
      if (
        message.type === "message" &&
        message.content[0].type === "output_text"
      ) {
        const part = message.content[0];
        assert.doesNotMatch(part.text, /\n\nSources:/);
        assert.deepStrictEqual(
          part.annotations.map((annotation: any) =>
            part.text.slice(annotation.start_index, annotation.end_index),
          ),
          sourceUrls,
        );
      }
    });

    test("dispatches only the first internal call and returns one public search item", async () => {
      const prepared = prepareSearch();
      let providerCalls = 0;
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const result = await runLoop({
        prepared,
        requests,
        rounds: [
          {
            chunks: [
              internalCall(prepared, "search-1", { query: "first query" }),
              internalCall(prepared, "search-2", { query: "second query" }),
              usagePart(),
            ],
          },
          {
            chunks: [new vscode.LanguageModelTextPart("Answer."), usagePart()],
          },
        ],
        provider: createProvider(async () => {
          providerCalls++;
          return [];
        }),
      });

      assert.strictEqual(providerCalls, 1);
      assert.strictEqual(
        result.output.filter(({ type }) => type === "web_search_call").length,
        1,
      );
      const toolResults = requests[1].messages
        .at(-1)
        ?.content.filter(
          (part) => part instanceof vscode.LanguageModelToolResultPart,
        );
      assert.strictEqual(toolResults?.length, 2);
    });

    test("gives client calls precedence and preserves visible content order", async () => {
      const prepared = prepareSearch({
        tools: [webSearchTool(), clientTool()],
      });
      let providerCalls = 0;
      const result = await runLoop({
        prepared,
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Checking. "),
              internalCall(prepared),
              new vscode.LanguageModelToolCallPart("client-1", "get_weather", {
                value: "Miami",
              }),
              new vscode.LanguageModelTextPart("Awaiting client."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          providerCalls++;
          return [];
        }),
      });

      assert.strictEqual(providerCalls, 0);
      assert.deepStrictEqual(
        result.output.map(({ type }) => type),
        ["message", "function_call", "message"],
      );
      assert.doesNotMatch(
        JSON.stringify(result.output),
        /agent_maestro_web_search/,
      );
    });

    test("serializes invalid model input as failed and synthesizes without dispatch", async () => {
      const prepared = prepareSearch();
      let providerCalls = 0;
      const result = await runLoop({
        prepared,
        rounds: [
          {
            chunks: [
              internalCall(prepared, "search-1", {
                query: "x",
                extra: true,
              }),
              usagePart(),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "I could not perform a valid web search.",
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          providerCalls++;
          return [];
        }),
      });

      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.output[0].type, "web_search_call");
      assert.strictEqual(result.output[0].status, "failed");
      if (
        result.output[0].type === "web_search_call" &&
        result.output[0].action.type === "search"
      ) {
        assert.deepStrictEqual(result.output[0].action.queries, []);
      }
    });

    test("turns provider failures into a failed search item and tool-free synthesis", async () => {
      const prepared = prepareSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const result = await runLoop({
        prepared,
        requests,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "Current web search was unavailable.",
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          throw new Error("secret provider failure");
        }),
      });

      assert.strictEqual(result.webSearchRequests, 1);
      assert.strictEqual(result.output[0].type, "web_search_call");
      if (result.output[0].type === "web_search_call") {
        assert.strictEqual(result.output[0].status, "failed");
      }
      assert.strictEqual(requests[1].options.tools, undefined);
      assert.doesNotMatch(
        JSON.stringify(result.output),
        /secret provider failure/,
      );
    });

    test("marks partial synthesis text as an incomplete message", async () => {
      const prepared = prepareSearch();
      const result = await runLoop({
        prepared,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [new vscode.LanguageModelTextPart("Partial answer")],
            error: new Error("Response too long for the configured limit"),
          },
        ],
        provider: createProvider(async () => []),
      });

      assert.strictEqual(result.incomplete, true);
      assert.strictEqual(result.output[0].type, "web_search_call");
      assert.strictEqual(result.output[0].status, "completed");
      assert.strictEqual(result.output[1].type, "message");
      if (result.output[1].type === "message") {
        assert.strictEqual(result.output[1].status, "incomplete");
      }
    });

    test("always emits a final assistant message after synthesis", async () => {
      const prepared = prepareSearch();
      const result = await runLoop({
        prepared,
        rounds: [
          { chunks: [internalCall(prepared), usagePart()] },
          { chunks: [usagePart()] },
        ],
        provider: createProvider(async () => []),
      });

      assert.deepStrictEqual(
        result.output.map(({ type }) => type),
        ["web_search_call", "message"],
      );
      const message = result.output[1];
      assert.strictEqual(message.type, "message");
      if (
        message.type === "message" &&
        message.content[0].type === "output_text"
      ) {
        assert.strictEqual(message.content[0].text, "");
      }
    });

    test("marks buffered partial no-search text as an incomplete message", async () => {
      const result = await runLoop({
        rounds: [
          {
            chunks: [new vscode.LanguageModelTextPart("Partial answer")],
            error: new Error("Response too long for the configured limit"),
          },
        ],
        provider: createProvider(async () => []),
      });

      assert.strictEqual(result.incomplete, true);
      assert.strictEqual(result.output[0].type, "message");
      if (result.output[0].type === "message") {
        assert.strictEqual(result.output[0].status, "incomplete");
      }
    });

    test("does not dispatch when the first round exhausts the output budget", async () => {
      const prepared = prepareSearch();
      let providerCalls = 0;
      const result = await runLoop({
        prepared,
        maxOutputTokens: 2,
        rounds: [
          {
            chunks: [internalCall(prepared), usagePart({ output: 2 })],
          },
        ],
        provider: createProvider(async () => {
          providerCalls++;
          return [];
        }),
      });

      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.incomplete, true);
      assert.strictEqual(result.output[0].type, "web_search_call");
      if (result.output[0].type === "web_search_call") {
        assert.strictEqual(result.output[0].status, "failed");
      }
    });
  });

  suite("route and streaming protocol", () => {
    test("rejects invalid search options before resolving the model", async () => {
      let modelResolutions = 0;
      const app = createTestApp({
        rounds: [],
        provider: createProvider(async () => []),
        onResolve: () => {
          modelResolutions++;
        },
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Search",
          tools: [webSearchTool({ external_web_access: false })],
        }),
      });

      assert.strictEqual(response.status, 400);
      assert.strictEqual(modelResolutions, 0);
      assert.strictEqual(
        ((await response.json()) as any).error.type,
        "invalid_request_error",
      );
    });

    test("rejects invalid parallel_tool_calls before resolving the model", async () => {
      let modelResolutions = 0;
      const app = createTestApp({
        rounds: [],
        provider: createProvider(async () => []),
        onResolve: () => {
          modelResolutions++;
        },
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Search",
          tools: [webSearchTool()],
          parallel_tool_calls: "false",
        }),
      });
      const body = (await response.json()) as any;

      assert.strictEqual(response.status, 400);
      assert.strictEqual(modelResolutions, 0);
      assert.strictEqual(body.error.param, "parallel_tool_calls");
    });

    test("preserves the legacy non-streaming envelope when search is not selected", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("No search needed."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => []),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Hello",
          tools: [webSearchTool()],
        }),
      });
      const body = (await response.json()) as Record<string, unknown>;

      assert.strictEqual(response.status, 200);
      for (const field of [
        "background",
        "completed_at",
        "parallel_tool_calls",
        "reasoning",
        "tool_choice",
        "tools",
      ]) {
        assert.ok(!Object.hasOwn(body, field), `${field} must remain omitted`);
      }
    });

    test("preserves legacy non-streaming text and client-call ordering when search is skipped", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Before. "),
              new vscode.LanguageModelToolCallPart("client-1", "get_weather", {
                value: "Miami",
              }),
              new vscode.LanguageModelTextPart("After."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => []),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Hello",
          tools: [webSearchTool(), clientTool()],
        }),
      });
      const body = (await response.json()) as any;

      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(
        body.output.map(({ type }: { type: string }) => type),
        ["message", "function_call"],
      );
      assert.strictEqual(body.output[0].content[0].text, "Before. After.");
    });

    test("omits nullable tool controls from fallback model options", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const app = createTestApp({
        requests,
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Search disabled."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => []),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Hello",
          tools: [webSearchTool()],
          tool_choice: "none",
          max_tool_calls: null,
          parallel_tool_calls: null,
        }),
      });
      const modelOptions = requests[0].options.modelOptions as Record<
        string,
        unknown
      >;

      assert.strictEqual(response.status, 200);
      assert.ok(!Object.hasOwn(modelOptions, "max_tool_calls"));
      assert.ok(!Object.hasOwn(modelOptions, "parallel_tool_calls"));
    });

    test("emits successful search, source, citation, and terminal events in order", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      let preparedName = "";
      const app = createTestApp({
        requests,
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelToolCallPart(
                "search-1",
                "agent_maestro_web_search",
                { query: "latest Miami International game result" },
              ),
              usagePart(),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "Miami International won. https://example.com/game",
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => [
          { title: "Game result", url: "https://example.com/game" },
        ]),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "What's the latest game result of Miami Intl",
          stream: true,
          tools: [{ type: "web_search" }],
          include: ["web_search_call.action.sources"],
        }),
      });
      const body = await response.text();
      preparedName = requests[0].options.tools?.[0].name ?? "";
      const events = parseSseData(body);
      const types = events.map(({ type }) => type);

      assert.strictEqual(response.status, 200);
      assert.strictEqual(preparedName, "agent_maestro_web_search");
      assert.deepStrictEqual(types, [
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
        "response.output_item.done",
        "response.output_item.added",
        "response.content_part.added",
        "response.output_text.delta",
        "response.output_text.annotation.added",
        "response.output_text.done",
        "response.content_part.done",
        "response.output_item.done",
        "response.completed",
      ]);

      const deltaEvent = events.find(
        ({ type }) => type === "response.output_text.delta",
      );
      const doneEvent = events.find(
        ({ type }) => type === "response.output_text.done",
      );
      const annotationEvent = events.find(
        ({ type }) => type === "response.output_text.annotation.added",
      );
      const terminalEvent = events.find(
        ({ type }) => type === "response.completed",
      );
      assert.ok(deltaEvent);
      assert.ok(doneEvent);
      assert.ok(annotationEvent);
      assert.ok(terminalEvent);
      const delta = deltaEvent.delta;
      const done = doneEvent.text;
      assert.strictEqual(delta, done);
      const annotation = annotationEvent.annotation;
      assert.strictEqual(
        done.slice(annotation.start_index, annotation.end_index),
        annotation.url,
      );
      const terminal = terminalEvent.response;
      assert.deepStrictEqual(terminal.output[0].action.sources, [
        { type: "url", url: "https://example.com/game" },
      ]);
      assert.doesNotMatch(
        body,
        /__agent_maestro|function_call.*agent_maestro_web_search/,
      );
    });

    test("omits searching for invalid private input but completes the call lifecycle", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelToolCallPart(
                "search-1",
                "agent_maestro_web_search",
                { query: "x" },
              ),
              usagePart(),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "No valid search was performed.",
              ),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          throw new Error("must not run");
        }),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Search",
          stream: true,
          tools: [webSearchTool()],
        }),
      });
      const body = await response.text();

      assert.doesNotMatch(body, /response\.web_search_call\.searching/);
      assert.match(body, /response\.web_search_call\.in_progress/);
      assert.match(body, /response\.web_search_call\.completed/);
      assert.match(body, /"status":"failed"/);
      assert.match(body, /response\.completed/);
    });

    test("includes searching for dispatched provider failures", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelToolCallPart(
                "search-1",
                "agent_maestro_web_search",
                { query: "latest result" },
              ),
              usagePart(),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart("Search was unavailable."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          throw new Error("provider unavailable");
        }),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Search",
          stream: true,
          tools: [webSearchTool()],
        }),
      });
      const body = await response.text();

      assert.match(body, /response\.web_search_call\.searching/);
      assert.match(body, /"type":"web_search_call".*"status":"failed"/);
      assert.match(body, /response\.completed/);
    });

    test("replays buffered ordinary output when automatic choice skips search", async () => {
      let providerCalls = 0;
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("No search needed."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          providerCalls++;
          return [];
        }),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Hello",
          stream: true,
          tools: [webSearchTool()],
        }),
      });
      const body = await response.text();

      assert.strictEqual(providerCalls, 0);
      assert.doesNotMatch(body, /response\.web_search_call/);
      assert.match(body, /No search needed/);
      assert.match(body, /response\.completed/);
    });

    test("echoes parallel_tool_calls false on the disabled-search fallback stream", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Search disabled."),
              usagePart(),
            ],
          },
        ],
        provider: createProvider(async () => {
          throw new Error("must not run");
        }),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Hello",
          stream: true,
          tools: [webSearchTool()],
          tool_choice: "none",
          parallel_tool_calls: false,
        }),
      });
      const events = parseSseData(await response.text());
      const completed = events.find(
        ({ type }) => type === "response.completed",
      );

      assert.ok(completed);
      assert.strictEqual(completed.response.parallel_tool_calls, false);
      assert.ok(
        events
          .filter(({ response }) => response)
          .every(({ response }) => response.parallel_tool_calls === false),
      );
    });

    test("emits response.incomplete and never response.completed on budget exhaustion", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelToolCallPart(
                "search-1",
                "agent_maestro_web_search",
                { query: "latest result" },
              ),
              usagePart({ output: 2 }),
            ],
          },
        ],
        provider: createProvider(async () => {
          throw new Error("must not run");
        }),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Search",
          stream: true,
          max_output_tokens: 2,
          tools: [webSearchTool()],
        }),
      });
      const body = await response.text();

      assert.match(body, /event: response\.incomplete/);
      assert.match(body, /"reason":"max_output_tokens"/);
      assert.doesNotMatch(body, /event: response\.completed/);
      assert.doesNotMatch(body, /response\.web_search_call\.searching/);
    });

    test("includes the next sequence_number on response.failed", async () => {
      const app = createTestApp({
        rounds: [
          {
            chunks: [
              new vscode.LanguageModelToolCallPart(
                "search-1",
                "agent_maestro_web_search",
                { query: "latest result" },
              ),
              usagePart(),
            ],
          },
          {
            chunks: [],
            error: new Error("synthesis failed"),
          },
        ],
        provider: createProvider(async () => []),
      });
      const response = await app.request("/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.6-test",
          input: "Search",
          stream: true,
          tools: [webSearchTool()],
        }),
      });
      const events = parseSseData(await response.text());
      const failed = events.find(({ type }) => type === "response.failed");
      assert.ok(failed);
      assert.strictEqual(failed.sequence_number, events.length - 1);
      assert.ok(!events.some(({ type }) => type === "response.completed"));
    });
  });
});
