import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import {
  AnthropicRequestValidationError,
  prepareAnthropicTools,
  runAnthropicWebSearchLoop,
} from "../../server/utils/anthropicWebSearch";
import {
  LanguageModelClientDisconnectedError,
  LanguageModelRequestLifecycle,
} from "../../server/utils/languageModelRequestLifecycle";
import {
  ExaMcpWebSearchProvider,
  parseEventStream,
} from "../../server/webSearch/exaMcpWebSearchProvider";
import {
  MAX_WEB_SEARCH_CONTEXT_CHARACTERS,
  WebSearchProvider,
  formatWebSearchEvidence,
  normalizeWebSearchResults,
  runWebSearchProviderWithTimeout,
} from "../../server/webSearch/webSearchProvider";

const serverTool = (overrides: Record<string, unknown> = {}) => ({
  type: "web_search_20250305",
  name: "web_search",
  ...overrides,
});

const clientTool = (name = "get_weather") => ({
  name,
  description: "Client tool",
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
  },
});

const usagePart = ({
  input = 10,
  output = 2,
  cacheRead = 0,
  cacheCreation = 0,
}: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
} = {}) =>
  new vscode.LanguageModelDataPart(
    new TextEncoder().encode(
      JSON.stringify({
        prompt_tokens: input + cacheRead + cacheCreation,
        completion_tokens: output,
        prompt_tokens_details: {
          cached_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
      }),
    ),
    "usage",
  );

type ModelChunk =
  | vscode.LanguageModelTextPart
  | vscode.LanguageModelToolCallPart
  | vscode.LanguageModelDataPart;

interface MockRound {
  chunks: ModelChunk[];
  delayMs?: number;
  error?: Error;
}

const createRoundModel = (
  rounds: MockRound[],
  requests: Array<{
    messages: readonly vscode.LanguageModelChatMessage[];
    options: vscode.LanguageModelChatRequestOptions;
  }>,
  countTokens: (text: string) => number = () => 1,
): vscode.LanguageModelChat =>
  ({
    id: "claude-web-search-test",
    name: "Claude Web Search Test",
    family: "claude",
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
          if (round.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, round.delayMs));
          }
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

const prepareServerSearch = (
  tools: unknown[] = [serverTool()],
  toolChoice: unknown = { type: "auto" },
) =>
  prepareAnthropicTools({
    tools,
    toolChoice,
    messages: [{ role: "user", content: "Search" }],
    serverWebSearchAvailable: true,
  });

const internalCall = (
  prepared: ReturnType<typeof prepareServerSearch>,
  id = "search-1",
  input: object = { query: "latest TypeScript release" },
) =>
  new vscode.LanguageModelToolCallPart(
    id,
    prepared.internalWebSearchToolName!,
    input,
  );

suite("Anthropic Server Web Search Test Suite", () => {
  suite("classification and validation", () => {
    test("preserves legacy tool-choice behavior when server search is absent", () => {
      const prepared = prepareAnthropicTools({
        tools: [clientTool("first"), clientTool("second")],
        toolChoice: { type: "tool", name: "first" },
        messages: [{ role: "user", content: "Use a client tool" }],
        serverWebSearchAvailable: true,
      });

      assert.deepStrictEqual(
        prepared.tools?.map(({ name }) => name),
        ["first", "second"],
      );
      assert.strictEqual(
        prepared.toolMode,
        vscode.LanguageModelChatToolMode.Required,
      );
      assert.strictEqual(prepared.usesWebSearchLoop, false);
    });

    test("classifies supported search without intercepting same-named client tools", () => {
      const prepared = prepareServerSearch([
        serverTool(),
        clientTool("web_search"),
        clientTool("WebSearch"),
      ]);

      assert.strictEqual(prepared.usesWebSearchLoop, true);
      assert.strictEqual(prepared.tools?.length, 3);
      assert.ok(
        prepared.tools?.some((tool) => tool.name === "web_search"),
        "same-named client tool remains visible",
      );
      assert.ok(
        prepared.tools?.some((tool) => tool.name === "WebSearch"),
        "case-sensitive client tool remains visible",
      );
      assert.ok(
        prepared.internalWebSearchToolName?.startsWith(
          "__agent_maestro_internal_",
        ),
      );
    });

    test("normalizes valid nullable metadata and request filters", () => {
      const prepared = prepareServerSearch([
        serverTool({
          max_uses: 5,
          allowed_domains: ["Example.COM", "example.com"],
          blocked_domains: null,
          user_location: { type: "approximate", country: "us" },
          cache_control: { type: "ephemeral" },
          strict: false,
          allowed_callers: ["direct"],
          defer_loading: false,
        }),
      ]);

      assert.deepStrictEqual(prepared.webSearch, {
        maxUses: 1,
        allowedDomains: ["example.com"],
        userLocation: { country: "US" },
      });
    });

    test("rejects unsupported search versions and invalid options", () => {
      const invalidTools = [
        [{ type: "web_search_20260201", name: "web_search" }],
        [serverTool({ max_uses: 0 })],
        [serverTool({ allowed_domains: ["https://example.com/path"] })],
        [
          serverTool({
            allowed_domains: ["example.com"],
            blocked_domains: ["blocked.example"],
          }),
        ],
        [
          serverTool({
            user_location: {
              type: "approximate",
              country: "US",
              city: "Seattle",
            },
          }),
        ],
        [serverTool({ user_location: { type: "precise", country: "US" } })],
        [
          serverTool({
            user_location: { type: "approximate", country: "ZZ" },
          }),
        ],
        [serverTool({ allowed_callers: ["code_execution"] })],
        [serverTool({ defer_loading: true })],
        [serverTool({ unsupported_option: true })],
      ];

      for (const tools of invalidTools) {
        assert.throws(
          () => prepareServerSearch(tools),
          (error: unknown) =>
            error instanceof AnthropicRequestValidationError &&
            error.code === "invalid_tool_definition",
        );
      }
    });
  });

  suite("tool choice and isolation", () => {
    test("handles none, auto, any, and named choices", () => {
      const tools = [serverTool(), clientTool()];
      const none = prepareServerSearch(tools, { type: "none" });
      assert.strictEqual(none.tools, undefined);
      assert.strictEqual(none.usesWebSearchLoop, false);

      const auto = prepareServerSearch(tools, { type: "auto" });
      assert.strictEqual(auto.toolMode, vscode.LanguageModelChatToolMode.Auto);
      assert.strictEqual(auto.tools?.length, 2);

      const any = prepareServerSearch(tools, { type: "any" });
      assert.strictEqual(
        any.toolMode,
        vscode.LanguageModelChatToolMode.Required,
      );
      assert.strictEqual(any.tools?.length, 2);

      const namedSearch = prepareServerSearch(tools, {
        type: "tool",
        name: "web_search",
      });
      assert.strictEqual(namedSearch.tools?.length, 1);
      assert.strictEqual(
        namedSearch.tools?.[0].name,
        namedSearch.internalWebSearchToolName,
      );

      const namedClient = prepareServerSearch(tools, {
        type: "tool",
        name: "get_weather",
      });
      assert.deepStrictEqual(
        namedClient.tools?.map(({ name }) => name),
        ["get_weather"],
      );
      assert.strictEqual(namedClient.usesWebSearchLoop, false);
    });

    test("rejects ambiguous named choices and unavailable required search", () => {
      assert.throws(
        () =>
          prepareServerSearch([serverTool(), clientTool("web_search")], {
            type: "tool",
            name: "web_search",
          }),
        (error: unknown) =>
          error instanceof AnthropicRequestValidationError &&
          error.code === "ambiguous_tool_choice",
      );

      assert.throws(
        () =>
          prepareAnthropicTools({
            tools: [serverTool()],
            toolChoice: { type: "tool", name: "web_search" },
            messages: [{ role: "user", content: "Search" }],
            serverWebSearchAvailable: false,
          }),
        (error: unknown) =>
          error instanceof AnthropicRequestValidationError &&
          error.code === "tool_unavailable",
      );
      assert.throws(
        () =>
          prepareAnthropicTools({
            tools: [serverTool()],
            toolChoice: { type: "any" },
            messages: [{ role: "user", content: "Search" }],
            serverWebSearchAvailable: false,
          }),
        (error: unknown) =>
          error instanceof AnthropicRequestValidationError &&
          error.code === "tool_unavailable",
      );
    });

    test("keeps same-named client tool available when the server provider is unavailable", () => {
      const prepared = prepareAnthropicTools({
        tools: [serverTool(), clientTool("web_search")],
        toolChoice: { type: "tool", name: "web_search" },
        messages: [{ role: "user", content: "Search" }],
        serverWebSearchAvailable: false,
      });

      assert.deepStrictEqual(
        prepared.tools?.map(({ name }) => name),
        ["web_search"],
      );
      assert.strictEqual(prepared.usesWebSearchLoop, false);
    });

    test("removes server search from immediate tool-result continuations", () => {
      const prepared = prepareAnthropicTools({
        tools: [serverTool(), clientTool()],
        toolChoice: { type: "auto" },
        messages: [
          { role: "user", content: "Search" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "client-1",
                name: "get_weather",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "client-1",
                content: "sunny",
              },
            ],
          },
        ],
        serverWebSearchAvailable: true,
      });

      assert.deepStrictEqual(
        prepared.tools?.map(({ name }) => name),
        ["get_weather"],
      );
      assert.strictEqual(prepared.usesWebSearchLoop, false);
    });

    test("validates disable_parallel_tool_use rules", () => {
      assert.throws(
        () =>
          prepareServerSearch([serverTool()], {
            type: "auto",
            disable_parallel_tool_use: true,
          }),
        AnthropicRequestValidationError,
      );
      assert.throws(
        () =>
          prepareAnthropicTools({
            tools: [clientTool()],
            toolChoice: {
              type: "auto",
              disable_parallel_tool_use: true,
            },
            messages: [{ role: "user", content: "Use a client tool" }],
            serverWebSearchAvailable: true,
          }),
        AnthropicRequestValidationError,
      );
      assert.throws(
        () =>
          prepareAnthropicTools({
            tools: [clientTool()],
            toolChoice: {
              type: "none",
              disable_parallel_tool_use: false,
            },
            messages: [{ role: "user", content: "Use a client tool" }],
            serverWebSearchAvailable: true,
          }),
        AnthropicRequestValidationError,
      );
      assert.doesNotThrow(() =>
        prepareAnthropicTools({
          tools: [clientTool()],
          toolChoice: {
            type: "auto",
            disable_parallel_tool_use: false,
          },
          messages: [{ role: "user", content: "Use a client tool" }],
          serverWebSearchAvailable: true,
        }),
      );
      assert.doesNotThrow(() =>
        prepareServerSearch([serverTool()], {
          type: "any",
          disable_parallel_tool_use: false,
        }),
      );
      assert.throws(
        () =>
          prepareServerSearch([serverTool()], {
            type: "none",
            disable_parallel_tool_use: false,
          }),
        AnthropicRequestValidationError,
      );
    });
  });

  suite("source normalization", () => {
    test("validates, deduplicates, bounds, and deterministically normalizes results", () => {
      const longSnippet = "x".repeat(MAX_WEB_SEARCH_CONTEXT_CHARACTERS * 2);
      const results = normalizeWebSearchResults([
        {
          title: "First",
          url: "https://example.com",
          snippet: longSnippet,
        },
        { title: "Duplicate", url: "https://example.com/" },
        { title: "Unsafe", url: "file:///etc/passwd" },
        { title: "Credential", url: "https://user:pass@example.net/" },
        { title: "Second", url: "http://example.org/path#fragment" },
      ]);

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].url, "https://example.com/");
      assert.ok(
        formatWebSearchEvidence(results).length <=
          MAX_WEB_SEARCH_CONTEXT_CHARACTERS,
      );
    });
  });

  suite("provider lifecycle", () => {
    test("does not invoke a provider for a pre-aborted request", async () => {
      const controller = new AbortController();
      const reason = new Error("request cancelled");
      controller.abort(reason);
      let providerCalls = 0;
      const provider: WebSearchProvider = {
        search: async () => {
          providerCalls++;
          return [];
        },
      };

      await assert.rejects(
        runWebSearchProviderWithTimeout(
          provider,
          { query: "current facts", maxResults: 5 },
          controller.signal,
          100,
        ),
        (error: unknown) => error === reason,
      );
      assert.strictEqual(providerCalls, 0);
    });
  });

  suite("hidden model loop", () => {
    test("does not call the provider when the model does not select search", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              new vscode.LanguageModelTextPart("No search needed."),
              usagePart(),
            ],
          },
        ],
        requests,
      );
      let providerCalls = 0;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Answer")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.webSearchRequests, 0);
      assert.strictEqual(result.stopReason, "end_turn");
    });

    test("executes one search and a tool-free synthesis with aggregated usage", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Checking current sources. "),
              internalCall(prepared),
              usagePart({
                input: 10,
                output: 3,
                cacheRead: 2,
                cacheCreation: 1,
              }),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "TypeScript is current; related notes are at https://typescriptlang.org/docs/latest.",
              ),
              usagePart({
                input: 20,
                output: 4,
                cacheRead: 3,
                cacheCreation: 2,
              }),
            ],
          },
        ],
        requests,
      );
      const providerRequests: unknown[] = [];
      const provider: WebSearchProvider = {
        search: async (request) => {
          providerRequests.push(request);
          return [
            {
              title: "TypeScript",
              url: "https://typescriptlang.org/docs/",
              snippet: "Release notes",
            },
          ];
        },
      };
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider,
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(requests.length, 2);
      assert.strictEqual(providerRequests.length, 1);
      assert.strictEqual(requests[1].options.tools, undefined);
      assert.strictEqual(requests[1].options.toolMode, undefined);
      assert.strictEqual(
        (requests[1].options.modelOptions as Record<string, unknown>)
          .max_tokens,
        97,
      );
      assert.strictEqual(result.webSearchRequests, 1);
      assert.strictEqual(result.stopReason, "end_turn");
      assert.deepStrictEqual(
        {
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
          input_tokens: result.usage.input_tokens,
        },
        {
          cache_creation_input_tokens: 3,
          cache_read_input_tokens: 5,
          input_tokens: 30,
        },
      );
      assert.match(
        result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
        /Sources:\n- https:\/\/typescriptlang\.org\/docs\//,
      );
      assert.ok(
        result.content.every(
          (block) =>
            block.type !== "tool_use" ||
            block.name !== prepared.internalWebSearchToolName,
        ),
      );
    });

    test("synthesizes after provider failure and counts the dispatched request", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "Search is temporarily unavailable.",
              ),
              usagePart(),
            ],
          },
        ],
        requests,
      );
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            throw new Error("provider secret must not escape");
          },
        },
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(requests.length, 2);
      assert.strictEqual(result.webSearchRequests, 1);
      assert.match(
        JSON.stringify(requests[1].messages),
        /provider_request_failed/,
      );
      assert.doesNotMatch(
        JSON.stringify(requests[1].messages),
        /provider secret/,
      );
    });

    test("turns invalid model input into a hidden error without dispatching", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              internalCall(prepared, "search-1", { query: "x", extra: true }),
              usagePart(),
            ],
          },
          {
            chunks: [
              new vscode.LanguageModelTextPart(
                "The generated search input was invalid.",
              ),
              usagePart(),
            ],
          },
        ],
        requests,
      );
      let providerCalls = 0;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.webSearchRequests, 0);
      assert.strictEqual(requests.length, 2);
      assert.match(JSON.stringify(requests[1].messages), /invalid_tool_input/);
    });

    test("turns provider timeout into a hidden error and synthesizes", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          { chunks: [internalCall(prepared), usagePart()] },
          {
            chunks: [
              new vscode.LanguageModelTextPart("Search timed out."),
              usagePart(),
            ],
          },
        ],
        requests,
      );
      let providerCancelled = false;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async (_request, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                providerCancelled = true;
                reject(signal.reason);
              });
            }),
        },
        lifecycle,
        maxTokens: 100,
        providerTimeoutMs: 5,
      });
      lifecycle.dispose();

      assert.strictEqual(providerCancelled, true);
      assert.strictEqual(result.webSearchRequests, 1);
      assert.strictEqual(requests.length, 2);
      assert.match(
        JSON.stringify(requests[1].messages),
        /provider_request_failed/,
      );
    });

    test("prioritizes mixed client calls and preserves visible order", async () => {
      const prepared = prepareServerSearch([serverTool(), clientTool()]);
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              new vscode.LanguageModelTextPart("First"),
              new vscode.LanguageModelToolCallPart("client-1", "get_weather", {
                value: "Seattle",
              }),
              internalCall(prepared),
              new vscode.LanguageModelTextPart("Last"),
              usagePart(),
            ],
          },
        ],
        requests,
      );
      let providerCalls = 0;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.stopReason, "tool_use");
      assert.deepStrictEqual(
        result.content.map((block) =>
          block.type === "text"
            ? block.text
            : block.type === "tool_use"
              ? block.name
              : block.type,
        ),
        ["First", "get_weather", "Last"],
      );
    });

    test("matches every parallel internal call and dispatches only the first", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              internalCall(prepared, "search-1"),
              internalCall(prepared, "search-2", { query: "second query" }),
              usagePart(),
            ],
          },
          {
            chunks: [new vscode.LanguageModelTextPart("Done"), usagePart()],
          },
        ],
        requests,
      );
      let providerCalls = 0;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(providerCalls, 1);
      assert.strictEqual(result.webSearchRequests, 1);
      const hiddenMessages = JSON.stringify(requests[1].messages);
      assert.match(hiddenMessages, /search-1/);
      assert.match(hiddenMessages, /search-2/);
      assert.match(hiddenMessages, /max_uses_exceeded/);
    });

    test("does not dispatch or synthesize after the output budget is exhausted", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Budget used"),
              internalCall(prepared),
              usagePart({ output: 5 }),
            ],
          },
        ],
        requests,
      );
      let providerCalls = 0;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        lifecycle,
        maxTokens: 5,
      });
      lifecycle.dispose();

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.stopReason, "max_tokens");
      assert.strictEqual(result.usage.output_tokens, 5);
    });

    test("does not dispatch or synthesize after a truncated first round", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          {
            chunks: [
              new vscode.LanguageModelTextPart("Partial answer"),
              internalCall(prepared),
            ],
            error: new Error("Response too long."),
          },
        ],
        requests,
        () => 1,
      );
      let providerCalls = 0;
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        lifecycle,
        maxTokens: 100,
      });
      lifecycle.dispose();

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(result.webSearchRequests, 0);
      assert.strictEqual(result.stopReason, "max_tokens");
      assert.deepStrictEqual(
        result.content.map((block) => block.type),
        ["text"],
      );
    });

    test("omits complete source entries that do not fit the remaining budget", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [
          { chunks: [internalCall(prepared), usagePart({ output: 3 })] },
          {
            chunks: [
              new vscode.LanguageModelTextPart("Answer"),
              usagePart({ output: 4 }),
            ],
          },
        ],
        requests,
        (text) => (text.includes("Sources:") ? 5 : 1),
      );
      const lifecycle = new LanguageModelRequestLifecycle(
        new AbortController().signal,
        1_000,
      );

      const result = await runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async () => [
            { title: "Source", url: "https://example.com/" },
          ],
        },
        lifecycle,
        maxTokens: 10,
      });
      lifecycle.dispose();

      assert.strictEqual(result.stopReason, "max_tokens");
      assert.strictEqual(result.usage.output_tokens, 7);
      assert.doesNotMatch(JSON.stringify(result.content), /Sources:/);
    });

    test("propagates cancellation to an active provider", async () => {
      const prepared = prepareServerSearch();
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel(
        [{ chunks: [internalCall(prepared), usagePart()] }],
        requests,
      );
      const clientAbort = new AbortController();
      const lifecycle = new LanguageModelRequestLifecycle(
        clientAbort.signal,
        1_000,
      );
      let providerCancelled = false;
      const run = runAnthropicWebSearchLoop({
        client: model,
        messages: [vscode.LanguageModelChatMessage.User("Search")],
        baseRequestOptions: {},
        preparedTools: prepared,
        provider: {
          search: async (_request, signal) =>
            new Promise((_, reject) => {
              signal.addEventListener("abort", () => {
                providerCancelled = true;
                reject(signal.reason);
              });
            }),
        },
        lifecycle,
        maxTokens: 100,
      });
      setTimeout(() => clientAbort.abort(), 5);

      await assert.rejects(run, LanguageModelClientDisconnectedError);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(providerCancelled, true);
      lifecycle.dispose();
    });
  });

  suite("Exa MCP provider", () => {
    test("parses multiline SSE data as one JSON-RPC response", () => {
      const responses = parseEventStream(
        [
          "event: message",
          'data: {"jsonrpc":"2.0",',
          'data: "id":1,',
          'data: "result":{"ok":true}}',
          "",
          "",
        ].join("\r\n"),
      );

      assert.strictEqual(responses.length, 1);
      assert.strictEqual(responses[0].id, 1);
      assert.deepStrictEqual(responses[0].result, { ok: true });
    });

    test("flattens JSON-RPC batch responses from one SSE event", () => {
      const responses = parseEventStream(
        [
          "event: message",
          'data: [{"jsonrpc":"2.0","id":1,"result":{"first":true}},',
          'data: {"jsonrpc":"2.0","id":2,"result":{"second":true}}]',
          "",
          "",
        ].join("\n"),
      );

      assert.deepStrictEqual(
        responses.map(({ id }) => id),
        [1, 2],
      );
    });

    test("initializes MCP and maps advanced filters without logging credentials", async () => {
      const requests: Array<{
        body: Record<string, unknown>;
        headers: Headers;
      }> = [];
      const responses = [
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-03-26" },
          }),
          {
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "session-1",
            },
          },
        ),
        new Response(null, { status: 202 }),
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [
                { name: "web_search_exa" },
                { name: "web_search_advanced_exa" },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results: [
                      {
                        title: "Example",
                        url: "https://example.com",
                        highlights: ["Evidence"],
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ];
      const fetchMock: typeof fetch = async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          headers: new Headers(init?.headers),
        });
        const response = responses.shift();
        if (!response) {
          throw new Error("Unexpected fetch");
        }
        return response;
      };
      const provider = new ExaMcpWebSearchProvider({
        endpoint: "https://exa.test/mcp",
        fetch: fetchMock,
        getApiKey: async () => "secret-api-key",
      });

      const results = await provider.search(
        {
          query: "current facts",
          maxResults: 5,
          allowedDomains: ["example.com"],
          userLocation: { country: "US" },
        },
        new AbortController().signal,
      );

      assert.strictEqual(requests.length, 4);
      assert.strictEqual(requests[0].body.method, "initialize");
      assert.strictEqual(requests[1].body.method, "notifications/initialized");
      assert.strictEqual(requests[2].body.method, "tools/list");
      assert.strictEqual(requests[3].body.method, "tools/call");
      assert.strictEqual(
        requests[3].headers.get("mcp-session-id"),
        "session-1",
      );
      assert.strictEqual(
        requests[3].headers.get("x-api-key"),
        "secret-api-key",
      );
      assert.deepStrictEqual(
        (
          (requests[3].body.params as Record<string, unknown>)
            .arguments as Record<string, unknown>
        ).includeDomains,
        ["example.com"],
      );
      assert.strictEqual(
        (
          (requests[3].body.params as Record<string, unknown>)
            .arguments as Record<string, unknown>
        ).userLocation,
        "US",
      );
      assert.deepStrictEqual(results, [
        {
          title: "Example",
          url: "https://example.com/",
          snippet: "Evidence",
        },
      ]);
    });

    test("supports anonymous simple search and surfaces protocol errors safely", async () => {
      const headers: Headers[] = [];
      const fetchMock: typeof fetch = async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return new Response("unauthorized detail containing credential", {
          status: 401,
        });
      };
      const provider = new ExaMcpWebSearchProvider({
        endpoint: "https://exa.test/mcp",
        fetch: fetchMock,
      });

      await assert.rejects(
        provider.search(
          { query: "current facts", maxResults: 5 },
          new AbortController().signal,
        ),
        /status 401/,
      );
      assert.strictEqual(headers[0].has("x-api-key"), false);
    });
  });

  suite("/v1/messages hidden-loop integration", () => {
    test("exposes client and server search together but isolates WebFetch from synthesis", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const rounds: MockRound[] = [
        {
          chunks: [
            new vscode.LanguageModelToolCallPart(
              "search-1",
              "__agent_maestro_internal_web_search_20250305",
              { query: "current facts" },
            ),
            usagePart(),
          ],
        },
        {
          chunks: [
            new vscode.LanguageModelTextPart(
              "The search found the current page.",
            ),
            new vscode.LanguageModelToolCallPart("fetch-1", "WebFetch", {
              url: "https://example.com/current",
            }),
            usagePart(),
          ],
        },
      ];
      const model = createRoundModel(rounds, requests);
      let providerCalls = 0;
      const app = new OpenAPIHono();
      registerAnthropicRoutes(app, {
        requestTimeoutMs: 1_000,
        webSearchProvider: {
          search: async () => {
            providerCalls++;
            return [{ title: "Current", url: "https://example.com/current" }];
          },
        },
        resolveChatModelClient: async () => ({ client: model }),
      });

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-web-search-test",
          max_tokens: 100,
          messages: [{ role: "user", content: "Find and fetch the page" }],
          tools: [
            clientTool("WebSearch"),
            serverTool(),
            clientTool("WebFetch"),
          ],
        }),
      });
      const body = (await response.json()) as Record<string, any>;

      assert.strictEqual(response.status, 200);
      assert.strictEqual(providerCalls, 1);
      assert.strictEqual(requests.length, 2);
      assert.deepStrictEqual(
        requests[0].options.tools?.map(({ name }) => name),
        [
          "WebSearch",
          "WebFetch",
          "__agent_maestro_internal_web_search_20250305",
        ],
      );
      assert.strictEqual(requests[1].options.tools, undefined);
      assert.strictEqual(requests[1].options.toolMode, undefined);
      assert.strictEqual(body.stop_reason, "end_turn");
      assert.ok(
        body.content.every(
          (block: Record<string, unknown>) => block.type === "text",
        ),
      );
      assert.doesNotMatch(JSON.stringify(body.content), /WebFetch|fetch-1/);
      assert.match(JSON.stringify(body.content), /example\.com\/current/);
    });

    test("allows client WebSearch to continue to WebFetch while suppressing mixed server search", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const rounds: MockRound[] = [
        {
          chunks: [
            new vscode.LanguageModelTextPart("I will use client search."),
            new vscode.LanguageModelToolCallPart(
              "client-search-1",
              "WebSearch",
              { value: "current facts" },
            ),
            new vscode.LanguageModelToolCallPart(
              "server-search-1",
              "__agent_maestro_internal_web_search_20250305",
              { query: "current facts" },
            ),
            usagePart(),
          ],
        },
        {
          chunks: [
            new vscode.LanguageModelToolCallPart("client-fetch-1", "WebFetch", {
              value: "https://example.com/current",
            }),
            usagePart(),
          ],
        },
      ];
      const model = createRoundModel(rounds, requests);
      let providerCalls = 0;
      const app = new OpenAPIHono();
      registerAnthropicRoutes(app, {
        requestTimeoutMs: 1_000,
        webSearchProvider: {
          search: async () => {
            providerCalls++;
            return [];
          },
        },
        resolveChatModelClient: async () => ({ client: model }),
      });
      const tools = [
        clientTool("WebSearch"),
        serverTool(),
        clientTool("WebFetch"),
      ];

      const firstResponse = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-web-search-test",
          max_tokens: 100,
          messages: [{ role: "user", content: "Find and fetch the page" }],
          tools,
        }),
      });
      const firstBody = (await firstResponse.json()) as Record<string, any>;

      assert.strictEqual(firstResponse.status, 200);
      assert.strictEqual(firstBody.stop_reason, "tool_use");
      assert.deepStrictEqual(
        firstBody.content.map((block: Record<string, unknown>) =>
          block.type === "text" ? block.text : block.name,
        ),
        ["I will use client search.", "WebSearch"],
      );
      assert.strictEqual(providerCalls, 0);

      const secondResponse = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-web-search-test",
          max_tokens: 100,
          messages: [
            { role: "user", content: "Find and fetch the page" },
            { role: "assistant", content: firstBody.content },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "client-search-1",
                  content: "Found https://example.com/current",
                },
              ],
            },
          ],
          tools,
        }),
      });
      const secondBody = (await secondResponse.json()) as Record<string, any>;

      assert.strictEqual(secondResponse.status, 200);
      assert.strictEqual(secondBody.stop_reason, "tool_use");
      assert.deepStrictEqual(
        secondBody.content.map((block: Record<string, unknown>) => block.name),
        ["WebFetch"],
      );
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(requests.length, 2);
      assert.deepStrictEqual(
        requests[1].options.tools?.map(({ name }) => name),
        ["WebSearch", "WebFetch"],
      );
      assert.ok(
        requests[1].options.tools?.every(
          ({ name }) => !name.startsWith("__agent_maestro_internal_"),
        ),
      );
    });

    test("returns a consolidated non-streaming answer with no internal blocks", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      let providerCalls = 0;
      const rounds: MockRound[] = [];
      const model = createRoundModel(rounds, requests);
      const app = new OpenAPIHono();
      registerAnthropicRoutes(app, {
        requestTimeoutMs: 1_000,
        webSearchProvider: {
          search: async () => {
            providerCalls++;
            return [
              {
                title: "Current source",
                url: "https://example.com/current",
              },
            ];
          },
        },
        resolveChatModelClient: async () => ({ client: model }),
      });
      rounds.push({
        chunks: [
          new vscode.LanguageModelTextPart("I will check. "),
          new vscode.LanguageModelToolCallPart(
            "search-1",
            "__agent_maestro_internal_web_search_20250305",
            { query: "current facts" },
          ),
          usagePart({ output: 2 }),
        ],
      });
      rounds.push({
        chunks: [
          new vscode.LanguageModelTextPart("Here is the current answer."),
          usagePart({ output: 3 }),
        ],
      });

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-web-search-test",
          max_tokens: 100,
          messages: [{ role: "user", content: "What is current?" }],
          tools: [serverTool()],
        }),
      });
      const body = (await response.json()) as Record<string, any>;

      assert.strictEqual(response.status, 200);
      assert.strictEqual(requests.length, 2);
      assert.strictEqual(providerCalls, 1);
      assert.strictEqual(body.stop_reason, "end_turn");
      assert.strictEqual(body.usage.server_tool_use.web_search_requests, 1);
      assert.strictEqual(body.usage.server_tool_use.web_fetch_requests, 0);
      assert.match(JSON.stringify(body.content), /example\.com\/current/);
      assert.doesNotMatch(
        JSON.stringify(body.content),
        /server_tool_use|web_search_tool_result|encrypted_content|encrypted_index/,
      );
    });

    test("retains heartbeat behavior while buffering a streaming search", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const rounds: MockRound[] = [];
      const model = createRoundModel(rounds, requests);
      const app = new OpenAPIHono();
      registerAnthropicRoutes(app, {
        heartbeatIntervalMs: 5,
        requestTimeoutMs: 1_000,
        webSearchProvider: {
          search: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return [{ title: "Current", url: "https://example.com/current" }];
          },
        },
        resolveChatModelClient: async () => ({ client: model }),
      });
      rounds.push({
        chunks: [
          new vscode.LanguageModelToolCallPart(
            "search-1",
            "__agent_maestro_internal_web_search_20250305",
            { query: "current facts" },
          ),
          usagePart(),
        ],
      });
      rounds.push({
        chunks: [
          new vscode.LanguageModelTextPart("Current answer"),
          usagePart(),
        ],
      });

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-web-search-test",
          max_tokens: 100,
          stream: true,
          messages: [{ role: "user", content: "What is current?" }],
          tools: [serverTool()],
        }),
      });
      const body = await response.text();

      assert.strictEqual(response.status, 200);
      assert.match(body, /event: ping\ndata: \{"type":"ping"\}/);
      assert.match(body, /event: message_stop/);
      assert.doesNotMatch(body, /__agent_maestro_internal_web_search/);
      assert.match(body, /"web_search_requests":1/);
    });

    test("returns invalid_request_error before model execution", async () => {
      const requests: Array<{
        messages: readonly vscode.LanguageModelChatMessage[];
        options: vscode.LanguageModelChatRequestOptions;
      }> = [];
      const model = createRoundModel([], requests);
      const app = new OpenAPIHono();
      registerAnthropicRoutes(app, {
        resolveChatModelClient: async () => ({ client: model }),
      });

      const response = await app.request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-web-search-test",
          max_tokens: 100,
          messages: [{ role: "user", content: "Search" }],
          tools: [serverTool()],
          tool_choice: { type: "tool", name: "web_search" },
        }),
      });
      const body = (await response.json()) as Record<string, any>;

      assert.strictEqual(response.status, 400);
      assert.strictEqual(body.error.type, "invalid_request_error");
      assert.strictEqual(body.error.code, "tool_unavailable");
      assert.strictEqual(requests.length, 0);
    });
  });
});
