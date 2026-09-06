import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";

import { createOpenAIAuthMiddleware } from "../../server/middleware/authMiddleware";
import { registerCodexSearchRoutes } from "../../server/routes/openai/codexSearchRoutes";
import {
  CodexSearchRequestValidationError,
  CodexStandaloneWebSearch,
  CodexStandaloneWebSearchOptions,
  codexOutputByteBudget,
  normalizePublicWebSearchUrl,
} from "../../server/webSearch/codexStandaloneWebSearch";
import {
  ExaAdvancedSearchApiRequest,
  ExaMcpClient,
  ExaMcpClientFactory,
  ExaMcpError,
  ExaMcpSession,
  ExaMcpSessionClient,
} from "../../server/webSearch/exaMcpClient";
import { logger } from "../../utils/logger";

interface ToolCall {
  args: Record<string, unknown>;
  name: string;
}

class FakeExaSession implements ExaMcpSessionClient {
  readonly calls: ToolCall[] = [];

  constructor(
    readonly authenticated: boolean,
    private readonly responder: (
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown> | unknown,
  ) {}

  async listTools(): Promise<string[]> {
    return ["web_search_exa", "web_search_advanced_exa", "web_fetch_exa"];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.calls.push({ name, args });
    return this.responder(name, args, signal);
  }

  async searchAdvanced(
    args: ExaAdvancedSearchApiRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const record = { ...args };
    this.calls.push({ name: "exa_search_api", args: record });
    return this.responder("exa_search_api", record, signal);
  }
}

const createClient = (
  session: ExaMcpSessionClient,
  onCreate?: () => void,
): ExaMcpClientFactory => ({
  createSession: async () => {
    onCreate?.();
    return session;
  },
});

const createStandaloneSearch = (
  options: CodexStandaloneWebSearchOptions,
): CodexStandaloneWebSearch =>
  new CodexStandaloneWebSearch({
    ...options,
    resolveHostname: options.resolveHostname ?? (async () => ["93.184.216.34"]),
  });

const searchResult = (
  title: string,
  url: string,
  snippet = `${title} evidence`,
) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        results: [{ title, url, highlights: [snippet] }],
      }),
    },
  ],
});

const request = (
  id: string,
  commands: Record<string, unknown>,
  settings?: Record<string, unknown>,
): Record<string, unknown> => ({
  id,
  model: "gpt-5.6",
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "private conversation context" }],
    },
  ],
  commands,
  ...(settings && { settings }),
});

suite("Codex standalone web search", () => {
  test("accepts the pinned Codex request and maps advanced policy without forwarding input", async () => {
    const session = new FakeExaSession(true, () =>
      searchResult("Agent Maestro", "https://github.com/Joouis/agent-maestro"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    });
    const response = await adapter.execute(
      {
        id: "01a056a2-424f-7622-8147-e1864b8e7fa0",
        model: "gpt-5.6",
        reasoning: null,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "private conversation context" },
            ],
          },
        ],
        commands: {
          search_query: [
            {
              q: "Agent Maestro web search",
              recency: 7,
              domains: ["https://github.com/"],
            },
          ],
          response_length: "short",
        },
        settings: {
          user_location: { type: "approximate", country: "us" },
          search_context_size: "low",
          filters: {
            allowed_domains: ["github.com"],
            blocked_domains: ["example.com"],
          },
          allowed_callers: ["direct"],
          external_web_access: true,
        },
        max_output_tokens: 2_500,
      },
      new AbortController().signal,
    );

    assert.strictEqual(session.calls.length, 1);
    assert.strictEqual(session.calls[0].name, "exa_search_api");
    assert.deepStrictEqual(session.calls[0].args.includeDomains, [
      "github.com",
    ]);
    assert.deepStrictEqual(session.calls[0].args.excludeDomains, [
      "example.com",
    ]);
    assert.strictEqual(session.calls[0].args.startPublishedDate, "2026-08-24");
    assert.strictEqual(session.calls[0].args.userLocation, "US");
    assert.strictEqual(
      JSON.stringify(session.calls[0].args).includes("text"),
      false,
    );
    assert.strictEqual(
      JSON.stringify(session.calls[0].args).includes("private conversation"),
      false,
    );
    assert.match(response.output, /UNTRUSTED WEB SEARCH EVIDENCE/);
    assert.match(response.output, /\[turn0search0\]/);
    assert.deepStrictEqual(response.results, [
      {
        type: "text_result",
        ref_id: "turn0search0",
        url: "https://github.com/Joouis/agent-maestro",
        title: "Agent Maestro",
        snippet: "Agent Maestro evidence",
      },
    ]);
  });

  test("uses simple search only for one unconstrained live query", async () => {
    const session = new FakeExaSession(false, () =>
      searchResult("Example", "https://example.com"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    await adapter.execute(
      request("simple", {
        search_query: [{ q: "current facts" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(session.calls[0].name, "web_search_exa");
    assert.deepStrictEqual(session.calls[0].args, {
      query: "current facts",
      numResults: 5,
    });
  });

  test("does not start provider work for an already-aborted request", async () => {
    let sessions = 0;
    const adapter = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () => {
          throw new Error("Unexpected provider call");
        }),
        () => sessions++,
      ),
    });
    const controller = new AbortController();
    controller.abort(new Error("client disconnected"));

    await assert.rejects(
      adapter.execute(
        request("pre-aborted", {
          search_query: [{ q: "facts" }],
        }),
        controller.signal,
      ),
      (error) => error instanceof ExaMcpError && error.category === "cancelled",
    );
    assert.strictEqual(sessions, 0);
  });

  test("caps low-context searches at three results", async () => {
    const session = new FakeExaSession(false, () => ({
      results: Array.from({ length: 5 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://${index}.example`,
      })),
    }));
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request(
        "low-context",
        { search_query: [{ q: "facts" }] },
        { search_context_size: "low" },
      ),
      new AbortController().signal,
    );

    assert.strictEqual(session.calls[0].args.numResults, 3);
    assert.strictEqual(response.results.length, 3);
  });

  test("dispatches anonymous queries sequentially and merges results round-robin", async () => {
    let active = 0;
    let maxActive = 0;
    const session = new FakeExaSession(false, async (_name, args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return args.query === "first"
        ? {
            results: [
              { title: "A", url: "https://a.example" },
              { title: "B", url: "https://b.example" },
            ],
          }
        : {
            results: [
              { title: "C", url: "https://c.example" },
              { title: "A duplicate", url: "https://a.example" },
              { title: "D", url: "https://d.example" },
            ],
          };
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request("multiple", {
        search_query: [{ q: "first" }, { q: "second" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(maxActive, 1);
    assert.deepStrictEqual(
      response.results.map(({ title }) => title),
      ["A", "C", "B", "D"],
    );
  });

  test("uses bounded concurrency for authenticated queries", async () => {
    let active = 0;
    let maxActive = 0;
    const session = new FakeExaSession(true, async (_name, args) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return searchResult(String(args.query), `https://${args.query}.example`);
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    await adapter.execute(
      request("concurrent", {
        search_query: [{ q: "one" }, { q: "two" }, { q: "three" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(maxActive, 2);
  });

  test("cancels and settles sibling provider calls after a concurrent failure", async () => {
    let siblingStarted = false;
    let siblingCancelled = false;
    const session = new FakeExaSession(true, async (_name, args, signal) => {
      if (args.query === "fails") {
        throw new ExaMcpError("rate_limited", "limited", 429);
      }
      siblingStarted = true;
      return new Promise((_, reject) => {
        const cancel = () => {
          siblingCancelled = true;
          reject(new ExaMcpError("cancelled", "cancelled"));
        };
        if (signal.aborted) {
          cancel();
          return;
        }
        signal.addEventListener("abort", cancel, { once: true });
      });
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request("concurrent-failure", {
        search_query: [{ q: "fails" }, { q: "hangs" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(siblingStarted, true);
    assert.strictEqual(siblingCancelled, true);
    assert.match(response.output, /rate_limited/);
  });

  test("stops awaiting sibling DNS resolution after a concurrent failure", async () => {
    let dnsStarted = false;
    let markDnsStarted = () => {};
    const waitForDns = new Promise<void>((resolve) => {
      markDnsStarted = resolve;
    });
    const session = new FakeExaSession(true, async (_name, args) => {
      if (args.query === "fails") {
        await waitForDns;
        throw new ExaMcpError("rate_limited", "limited", 429);
      }
      return searchResult("Hanging DNS", "https://hang.example/result");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
      resolveHostname: () => {
        dnsStarted = true;
        markDnsStarted();
        return new Promise(() => {});
      },
    });

    const response = await adapter.execute(
      request("concurrent-dns-failure", {
        search_query: [{ q: "fails" }, { q: "hangs" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(dnsStarted, true);
    assert.match(response.output, /rate_limited/);
  });

  test("does not dispatch when allowlists have no usable intersection", async () => {
    let sessions = 0;
    const session = new FakeExaSession(false, () => {
      throw new Error("Unexpected provider call");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session, () => sessions++),
    });

    const response = await adapter.execute(
      request(
        "filtered",
        {
          search_query: [{ q: "facts", domains: ["a.example"] }],
        },
        {
          filters: { allowed_domains: ["b.example"] },
        },
      ),
      new AbortController().signal,
    );

    assert.strictEqual(sessions, 0);
    assert.match(response.output, /required domain filters/);
  });

  test("treats empty allowlists as absent when intersecting filters", async () => {
    const session = new FakeExaSession(true, () =>
      searchResult("Example", "https://example.com/result"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request(
        "empty-allowlist",
        {
          search_query: [{ q: "facts", domains: ["example.com"] }],
        },
        { filters: { allowed_domains: [] } },
      ),
      new AbortController().signal,
    );

    assert.strictEqual(session.calls[0].name, "exa_search_api");
    assert.deepStrictEqual(session.calls[0].args.includeDomains, [
      "example.com",
    ]);
    assert.strictEqual(response.results.length, 1);
  });

  test("does not discover MCP tools for independent advanced search", async () => {
    let listCalls = 0;
    const session: ExaMcpSessionClient = {
      authenticated: true,
      callTool: async () => {
        throw new Error("Unexpected MCP tool call");
      },
      listTools: async () => {
        listCalls++;
        throw new Error("Unexpected MCP discovery");
      },
      searchAdvanced: async () =>
        searchResult("Example", "https://example.com/result"),
    };
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request("independent-advanced", {
        search_query: [{ q: "facts", domains: ["example.com"] }],
        open: [{ ref_id: "unknown-reference" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(listCalls, 0);
    assert.strictEqual(response.results.length, 1);
    assert.match(response.output, /unknown_reference/);
  });

  test("maps anonymous advanced filters and returns highlights without extracted text", async () => {
    const session = new FakeExaSession(false, () => ({
      results: [
        {
          title: "Example",
          url: "https://example.com/result",
          publishedDate: "2026-08-29",
          highlights: ["Relevant evidence"],
          text: "UNUSED_TEXT_SENTINEL".repeat(1_000),
          summary: "UNUSED_SUMMARY_SENTINEL",
        },
      ],
    }));
    const adapter = createStandaloneSearch({
      client: createClient(session),
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    });

    const response = await adapter.execute(
      request(
        "anonymous-advanced",
        {
          search_query: [{ q: "facts", domains: ["example.com"], recency: 7 }],
        },
        {
          filters: {
            allowed_domains: ["example.com", "other.example"],
            blocked_domains: ["blocked.example"],
          },
          user_location: { type: "approximate", country: "us" },
        },
      ),
      new AbortController().signal,
    );

    assert.deepStrictEqual(session.calls, [
      {
        name: "web_search_advanced_exa",
        args: {
          query: "facts",
          numResults: 5,
          highlightsMaxCharacters: 1_200,
          includeDomains: ["example.com"],
          excludeDomains: ["blocked.example"],
          startPublishedDate: "2026-08-24",
          userLocation: "US",
          textMaxCharacters: 1,
          enableHighlights: true,
        },
      },
    ]);
    assert.deepStrictEqual(response.results, [
      {
        type: "text_result",
        ref_id: "turn0search0",
        url: "https://example.com/result",
        title: "Example",
        snippet: "Relevant evidence",
      },
    ]);
    assert.match(response.output, /Published: 2026-08-29/);
    assert.doesNotMatch(JSON.stringify(response), /UNUSED_/);
    assert.doesNotMatch(JSON.stringify(session.calls), /private conversation/);
  });

  test("preserves anonymous cache-only modes without filling the page cache or fetching pages", async () => {
    for (const mode of [false, "cached", "indexed"]) {
      const session = new FakeExaSession(false, () => ({
        results: [
          {
            title: "Cached result",
            url: "https://example.com/result",
            highlights: ["Cached evidence"],
            text: "Text that must not populate the page cache",
          },
        ],
      }));
      const adapter = createStandaloneSearch({ client: createClient(session) });
      const search = await adapter.execute(
        request(
          "anonymous-cache",
          { search_query: [{ q: "facts" }] },
          { external_web_access: mode },
        ),
        new AbortController().signal,
      );
      assert.strictEqual(search.results.length, 1);
      assert.strictEqual(session.calls[0].name, "web_search_advanced_exa");
      assert.strictEqual(session.calls[0].args.maxAgeHours, -1);
      const page = await adapter.execute(
        request(
          "anonymous-cache",
          {
            open: [{ ref_id: "turn0search0" }],
            find: [{ ref_id: "turn0search0", pattern: "Cached" }],
          },
          { external_web_access: mode },
        ),
        new AbortController().signal,
      );
      assert.match(page.output, /cache_only_page_not_cached/);
      assert.strictEqual(session.calls.length, 1);
    }
  });

  test("does not retry an anonymous cache miss with live access", async () => {
    const session = new FakeExaSession(false, () => ({ results: [] }));
    const adapter = createStandaloneSearch({ client: createClient(session) });
    const response = await adapter.execute(
      request(
        "cache-miss",
        { search_query: [{ q: "facts" }] },
        { external_web_access: false },
      ),
      new AbortController().signal,
    );
    assert.strictEqual(session.calls.length, 1);
    assert.strictEqual(session.calls[0].args.maxAgeHours, -1);
    assert.deepStrictEqual(response.results, []);
    assert.match(response.output, /No usable web search results/);
  });

  test("keeps mixed anonymous simple and advanced searches sequential", async () => {
    let active = 0;
    let maxActive = 0;
    const session = new FakeExaSession(false, async (_name, args) => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return searchResult(String(args.query), `https://${args.query}.example`);
    });
    const adapter = createStandaloneSearch({ client: createClient(session) });
    const response = await adapter.execute(
      request("mixed-anonymous", {
        search_query: [
          { q: "simple" },
          { q: "filtered", domains: ["filtered.example"] },
        ],
      }),
      new AbortController().signal,
    );
    assert.strictEqual(maxActive, 1);
    assert.deepStrictEqual(
      session.calls.map(({ name }) => name),
      ["web_search_exa", "web_search_advanced_exa"],
    );
    assert.deepStrictEqual(
      response.results.map(({ title }) => title),
      ["simple", "filtered"],
    );
  });

  test("does not broaden anonymous advanced search when its MCP tool is unavailable", async () => {
    const session = new FakeExaSession(false, () => {
      throw new Error("Unexpected provider call");
    });
    session.listTools = async () => ["web_search_exa", "web_fetch_exa"];
    const adapter = createStandaloneSearch({ client: createClient(session) });
    const response = await adapter.execute(
      request("missing-advanced", {
        search_query: [{ q: "facts", domains: ["example.com"] }],
      }),
      new AbortController().signal,
    );
    assert.match(response.output, /protocol_error/);
    assert.deepStrictEqual(response.results, []);
    assert.strictEqual(session.calls.length, 0);
  });

  test("bounds anonymous advanced highlights and never substitutes raw text", async () => {
    const session = new FakeExaSession(false, () => ({
      results: [
        {
          title: "No highlights",
          url: "https://example.com/one",
          text: "RAW_TEXT_SENTINEL",
        },
        {
          title: "Long highlights",
          url: "https://example.com/two",
          highlights: ["字".repeat(20_000)],
          text: "RAW_TEXT_SENTINEL",
        },
      ],
    }));
    const adapter = createStandaloneSearch({ client: createClient(session) });
    const response = await adapter.execute(
      {
        ...request("bounded-advanced", {
          search_query: [{ q: "facts", domains: ["example.com"] }],
        }),
        max_output_tokens: 500,
      },
      new AbortController().signal,
    );
    assert.ok(Buffer.byteLength(response.output) <= codexOutputByteBudget(500));
    assert.strictEqual(response.results.length, 2);
    assert.strictEqual(response.results[0].snippet, undefined);
    assert.doesNotMatch(JSON.stringify(response), /RAW_TEXT_SENTINEL/);
  });

  test("supports reference open and cached literal find", async () => {
    let fetchCalls = 0;
    const session = new FakeExaSession(false, (name) => {
      if (name === "web_search_exa") {
        return searchResult("Match report", "https://sports.example/report");
      }
      fetchCalls++;
      return {
        content: [
          {
            type: "text",
            text: [
              "# Match report",
              "URL: https://sports.example/report",
              "",
              "Inter Miami played on Sunday.",
              "The final score was 3-1.",
              "Attendance was high.",
            ].join("\n"),
          },
        ],
      };
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    await adapter.execute(
      request("references", {
        search_query: [{ q: "Inter Miami result" }],
      }),
      new AbortController().signal,
    );
    const opened = await adapter.execute(
      request("references", {
        open: [{ ref_id: "turn0search0", lineno: 4 }],
      }),
      new AbortController().signal,
    );
    const found = await adapter.execute(
      request("references", {
        find: [{ ref_id: "turn1fetch0", pattern: "final score" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(fetchCalls, 1);
    assert.match(opened.output, /Reference: turn1fetch0/);
    assert.match(opened.output, /L4: Inter Miami played on Sunday/);
    assert.match(found.output, /L5: The final score was 3-1/);
  });

  test("reuses one pending fetch reference for repeated page operations", async () => {
    let fetchCalls = 0;
    const session = new FakeExaSession(false, (name) => {
      if (name === "web_fetch_exa") {
        fetchCalls++;
        return {
          content: [{ type: "text", text: "Repeated page content" }],
        };
      }
      return searchResult("Example", "https://example.com/result");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    await adapter.execute(
      request("repeated-page", {
        search_query: [{ q: "facts" }],
      }),
      new AbortController().signal,
    );
    const repeated = await adapter.execute(
      request("repeated-page", {
        open: [{ ref_id: "turn0search0" }, { ref_id: "turn0search0" }],
      }),
      new AbortController().signal,
    );
    const found = await adapter.execute(
      request("repeated-page", {
        find: [{ ref_id: "turn1fetch0", pattern: "content" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(fetchCalls, 1);
    assert.doesNotMatch(repeated.output, /turn1fetch1/);
    assert.strictEqual(
      repeated.output.match(/Reference: turn1fetch0/g)?.length,
      2,
    );
    assert.match(found.output, /Repeated page content/);
  });

  test("serializes reference transactions sharing one session id", async () => {
    let releaseSecondPage = () => {};
    let markSecondPageStarted = () => {};
    const secondPageStarted = new Promise<void>((resolve) => {
      markSecondPageStarted = resolve;
    });
    const session = new FakeExaSession(false, (name, args) => {
      if (name !== "web_fetch_exa") {
        throw new Error("Unexpected search call");
      }
      const url = (args.urls as string[])[0];
      if (url.endsWith("/second")) {
        markSecondPageStarted();
        return new Promise((resolve) => {
          releaseSecondPage = () =>
            resolve({
              content: [{ type: "text", text: "Second page" }],
            });
        });
      }
      return { content: [{ type: "text", text: "First page" }] };
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    const firstRequest = adapter.execute(
      request("shared-session", {
        open: [
          { ref_id: "https://example.com/first" },
          { ref_id: "https://example.com/second" },
        ],
      }),
      new AbortController().signal,
    );
    await secondPageStarted;
    let secondSettled = false;
    const secondRequest = adapter
      .execute(
        request("shared-session", {
          open: [{ ref_id: "https://example.com/first" }],
        }),
        new AbortController().signal,
      )
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(secondSettled, false);

    releaseSecondPage();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    const reopened = await adapter.execute(
      request("shared-session", {
        open: [{ ref_id: "turn0fetch0" }],
      }),
      new AbortController().signal,
    );

    assert.match(first.output, /Reference: turn0fetch0/);
    assert.match(second.output, /Reference: turn0fetch0/);
    assert.match(reopened.output, /First page/);
  });

  test("keeps the session lock queued when a waiter is cancelled", async () => {
    let releaseFirst = () => {};
    let markFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const fetchedUrls: string[] = [];
    const session = new FakeExaSession(false, (name, args) => {
      if (name !== "web_fetch_exa") {
        throw new Error("Unexpected search call");
      }
      const url = (args.urls as string[])[0];
      fetchedUrls.push(url);
      if (url.endsWith("/first")) {
        markFirstStarted();
        return new Promise((resolve) => {
          releaseFirst = () =>
            resolve({
              content: [{ type: "text", text: "First page" }],
            });
        });
      }
      return { content: [{ type: "text", text: url }] };
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    const first = adapter.execute(
      request("cancelled-waiter", {
        open: [{ ref_id: "https://example.com/first" }],
      }),
      new AbortController().signal,
    );
    await firstStarted;

    const secondController = new AbortController();
    const second = adapter.execute(
      request("cancelled-waiter", {
        open: [{ ref_id: "https://example.com/second" }],
      }),
      secondController.signal,
    );
    const secondRejected = assert.rejects(
      second,
      (error) => error instanceof ExaMcpError && error.category === "cancelled",
    );
    secondController.abort(new Error("client disconnected"));
    const third = adapter.execute(
      request("cancelled-waiter", {
        open: [{ ref_id: "https://example.com/third" }],
      }),
      new AbortController().signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(fetchedUrls, ["https://example.com/first"]);

    releaseFirst();
    await Promise.all([first, secondRejected, third]);
    assert.deepStrictEqual(fetchedUrls, [
      "https://example.com/first",
      "https://example.com/third",
    ]);
  });

  test("keeps later open and find matches visible after an oversized line", async () => {
    const session = new FakeExaSession(false, () => ({
      content: [
        {
          type: "text",
          text: `${"x".repeat(2_000)}\nFinal score: 7-1`,
        },
      ],
    }));
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    const opened = await adapter.execute(
      {
        ...request("long-page", {
          open: [{ ref_id: "https://example.com/report" }],
        }),
        max_output_tokens: 300,
      },
      new AbortController().signal,
    );
    const found = await adapter.execute(
      {
        ...request("long-page", {
          find: [{ ref_id: "turn0fetch0", pattern: "Final score" }],
        }),
        max_output_tokens: 300,
      },
      new AbortController().signal,
    );

    assert.match(opened.output, /Final score: 7-1/);
    assert.match(found.output, /Final score: 7-1/);
  });

  test("returns recoverable results for fetch timeout and empty content", async () => {
    const timedOut = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () => {
          throw new ExaMcpError("timeout", "timed out", 504);
        }),
      ),
    });
    const empty = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () => ({
          content: [{ type: "text", text: "No content found." }],
        })),
      ),
    });

    const timeoutResponse = await timedOut.execute(
      request("fetch-timeout", {
        open: [{ ref_id: "https://example.com/report" }],
      }),
      new AbortController().signal,
    );
    const emptyResponse = await empty.execute(
      request("fetch-empty", {
        open: [{ ref_id: "https://example.com/report" }],
      }),
      new AbortController().signal,
    );

    assert.match(timeoutResponse.output, /timeout/);
    assert.match(emptyResponse.output, /provider_error/);
  });

  test("does not fetch uncached pages when external access is cache-only", async () => {
    let sessions = 0;
    const adapter = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () => {
          throw new Error("Unexpected provider call");
        }),
        () => sessions++,
      ),
    });

    const responses = await Promise.all([
      adapter.execute(
        request(
          "cache-only-open",
          { open: [{ ref_id: "https://example.com/report" }] },
          { external_web_access: false },
        ),
        new AbortController().signal,
      ),
      adapter.execute(
        request(
          "cache-only-find",
          {
            find: [
              {
                ref_id: "https://example.com/report",
                pattern: "score",
              },
            ],
          },
          { external_web_access: "indexed" },
        ),
        new AbortController().signal,
      ),
    ]);

    assert.strictEqual(sessions, 0);
    for (const response of responses) {
      assert.match(response.output, /cache_only_page_not_cached/);
    }
  });

  test("prioritizes unavailable-operation notices over search evidence", async () => {
    const session = new FakeExaSession(false, () =>
      searchResult(
        "Optional evidence",
        "https://example.com/result",
        "x".repeat(2_000),
      ),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      {
        ...request("priority-status", {
          search_query: [{ q: "simple" }],
          sports: [{ fn: "schedule", league: "nba" }],
        }),
        max_output_tokens: 220,
      },
      new AbortController().signal,
    );

    assert.match(response.output, /unsupported_command: sports/);
    assert.doesNotMatch(response.output, /Optional evidence/);
    assert.deepStrictEqual(response.results, []);
  });

  test("does not emit lower-priority evidence when a status notice cannot fit", async () => {
    const session = new FakeExaSession(false, () =>
      searchResult("E", "https://a.co/"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      {
        ...request("priority-tight-status", {
          search_query: [{ q: "simple" }],
          sports: [{ fn: "schedule", league: "nba" }],
        }),
        max_output_tokens: 130,
      },
      new AbortController().signal,
    );

    assert.strictEqual(response.output, "Web search unavailable.");
    assert.deepStrictEqual(response.results, []);
  });

  test("prioritizes successful page operations over search evidence", async () => {
    const session = new FakeExaSession(false, (name) =>
      name === "web_fetch_exa"
        ? {
            content: [
              {
                type: "text",
                text: "Page result that must remain visible.",
              },
            ],
          }
        : searchResult(
            "Optional evidence",
            "https://example.com/result",
            "x".repeat(2_000),
          ),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      {
        ...request("priority-page", {
          search_query: [{ q: "simple" }],
          open: [{ ref_id: "https://example.com/page" }],
        }),
        max_output_tokens: 220,
      },
      new AbortController().signal,
    );

    assert.match(response.output, /Reference: turn0fetch0/);
    assert.doesNotMatch(response.output, /Optional evidence/);
    assert.deepStrictEqual(response.results, []);
  });

  test("rejects direct local, private, and link-local page targets", async () => {
    const adapter = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () => {
          throw new Error("Unexpected provider call");
        }),
      ),
    });

    for (const target of [
      "http://localhost/admin",
      "http://localhost./admin",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://[100::1]/",
      "http://[64:ff9b::7f00:1]/",
      "http://[2002:7f00:1::]/",
      "http://[3fff::1]/",
      "http://[4000::1]/",
    ]) {
      await assert.rejects(
        adapter.execute(
          request(`private-${target}`, { open: [{ ref_id: target }] }),
          new AbortController().signal,
        ),
        (error) =>
          error instanceof CodexSearchRequestValidationError &&
          error.param === "commands.open.0.ref_id",
      );
    }
    assert.strictEqual(
      normalizePublicWebSearchUrl("https://[2606:4700:4700::1111]/"),
      "https://[2606:4700:4700::1111]/",
    );
    assert.strictEqual(
      normalizePublicWebSearchUrl("https://EXAMPLE.com./path#fragment"),
      "https://example.com/path",
    );
  });

  test("rejects DNS aliases that resolve to non-public addresses", async () => {
    let sessions = 0;
    const adapter = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () => {
          throw new Error("Unexpected provider call");
        }),
        () => sessions++,
      ),
      resolveHostname: async () => ["127.0.0.1", "::1"],
    });

    for (const target of ["http://localtest.me/", "http://127.0.0.1.nip.io/"]) {
      const response = await adapter.execute(
        request(`dns-private-${target}`, {
          open: [{ ref_id: target }],
        }),
        new AbortController().signal,
      );
      assert.match(response.output, /non_public_url/);
    }
    assert.strictEqual(sessions, 0);
  });

  test("drops search-result hostnames resolving to non-public addresses", async () => {
    const session = new FakeExaSession(false, () => ({
      results: [
        { title: "Alias", url: "http://localtest.me/" },
        { title: "Public", url: "https://example.com/report" },
      ],
    }));
    const adapter = createStandaloneSearch({
      client: createClient(session),
      resolveHostname: async (hostname) =>
        hostname === "localtest.me" ? ["127.0.0.1"] : ["93.184.216.34"],
    });

    const response = await adapter.execute(
      request("dns-public-results", {
        search_query: [{ q: "facts" }],
      }),
      new AbortController().signal,
    );

    assert.deepStrictEqual(
      response.results.map(({ title }) => title),
      ["Public"],
    );
  });

  test("reuses one DNS validation for duplicate page operations", async () => {
    let dnsLookups = 0;
    let fetchCalls = 0;
    const session = new FakeExaSession(false, (name) => {
      if (name === "web_fetch_exa") {
        fetchCalls++;
        return { content: [{ type: "text", text: "Repeated page" }] };
      }
      throw new Error("Unexpected search call");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
      resolveHostname: async () => {
        dnsLookups++;
        return ["93.184.216.34"];
      },
    });
    const url = "https://example.com/repeated";

    await adapter.execute(
      request("duplicate-dns", {
        open: Array.from({ length: 16 }, () => ({ ref_id: url })),
        find: Array.from({ length: 16 }, () => ({
          ref_id: url,
          pattern: "page",
        })),
      }),
      new AbortController().signal,
    );

    assert.strictEqual(dnsLookups, 1);
    assert.strictEqual(fetchCalls, 1);
  });

  test("stops waiting for DNS at the request timeout and reports timeout", async () => {
    const session = new FakeExaSession(false, () =>
      searchResult("Public", "https://example.com/report"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
      resolveHostname: () => new Promise(() => {}),
      timeoutMs: 10,
    });

    const response = await adapter.execute(
      request("dns-timeout", {
        search_query: [{ q: "facts" }],
      }),
      new AbortController().signal,
    );
    assert.match(response.output, /timeout/);
    assert.match(response.output, /timeout/);
  });

  test("drops non-public URLs returned by the search provider", async () => {
    const session = new FakeExaSession(false, () => ({
      results: [
        { title: "Local", url: "http://127.0.0.1/admin" },
        { title: "Public", url: "https://example.com/report" },
      ],
    }));
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request("public-results", {
        search_query: [{ q: "facts" }],
      }),
      new AbortController().signal,
    );

    assert.deepStrictEqual(
      response.results.map(({ title }) => title),
      ["Public"],
    );
    assert.doesNotMatch(response.output, /127\.0\.0\.1/);
  });

  test("returns recoverable results for unsupported commands, unknown references, and rate limits", async () => {
    let sessions = 0;
    const unused = new FakeExaSession(false, () => {
      throw new Error("Unexpected provider call");
    });
    const adapter = createStandaloneSearch({
      client: createClient(unused, () => sessions++),
    });
    const unsupported = await adapter.execute(
      request("unsupported", {
        sports: [{ fn: "schedule", league: "nba" }],
      }),
      new AbortController().signal,
    );
    const unknown = await adapter.execute(
      request("unknown", {
        open: [{ ref_id: "turn9search9" }],
      }),
      new AbortController().signal,
    );
    const limited = createStandaloneSearch({
      client: {
        createSession: async () => {
          throw new ExaMcpError("rate_limited", "limited", 429);
        },
      },
    });
    const rateLimited = await limited.execute(
      request("limited", {
        search_query: [{ q: "facts" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(sessions, 0);
    assert.match(unsupported.output, /unsupported_command: sports/);
    assert.match(unknown.output, /unknown_reference/);
    assert.match(rateLimited.output, /rate_limited/);
    assert.deepStrictEqual(rateLimited.results, []);
  });

  test("applies max_output_tokens to every recoverable response", async () => {
    const providerFailureAdapter = createStandaloneSearch({
      client: {
        createSession: async () => {
          throw new ExaMcpError("rate_limited", "limited", 429);
        },
      },
    });
    const noDispatchAdapter = createStandaloneSearch({
      client: {
        createSession: async () => {
          throw new Error("Unexpected provider call");
        },
      },
    });
    const responses = [
      await providerFailureAdapter.execute(
        {
          ...request("tiny-error", {
            search_query: [{ q: "facts" }],
          }),
          max_output_tokens: 1,
        },
        new AbortController().signal,
      ),
      await noDispatchAdapter.execute(
        {
          ...request("tiny-unsupported", {
            sports: [{ fn: "schedule", league: "nba" }],
          }),
          max_output_tokens: 1,
        },
        new AbortController().signal,
      ),
      await noDispatchAdapter.execute(
        {
          ...request(
            "tiny-setting",
            { search_query: [{ q: "facts" }] },
            {
              user_location: {
                type: "approximate",
                city: "Miami",
              },
            },
          ),
          max_output_tokens: 1,
        },
        new AbortController().signal,
      ),
    ];

    for (const response of responses) {
      assert.ok(
        new TextEncoder().encode(response.output).byteLength <=
          codexOutputByteBudget(1),
      );
    }
  });

  test("logs provider statistics from failed execution paths", async () => {
    const messages: string[] = [];
    const originalInfo = logger.info;
    logger.info = (message: string) => messages.push(message);
    try {
      const authenticated = createStandaloneSearch({
        client: createClient(
          new FakeExaSession(true, () => {
            throw new ExaMcpError("rate_limited", "limited", 429);
          }),
        ),
      });
      await authenticated.execute(
        request("failed-authenticated", {
          search_query: [{ q: "facts", domains: ["example.com"] }],
        }),
        new AbortController().signal,
      );

      const partial = createStandaloneSearch({
        client: createClient(
          new FakeExaSession(false, (_name, args) => {
            if (args.query === "first") {
              return searchResult("First", "https://example.com/first");
            }
            throw new ExaMcpError("rate_limited", "limited", 429);
          }),
        ),
      });
      await partial.execute(
        request("failed-partial", {
          search_query: [{ q: "first" }, { q: "second" }],
        }),
        new AbortController().signal,
      );
    } finally {
      logger.info = originalInfo;
    }

    assert.ok(
      messages.some(
        (message) =>
          message.includes("provider_calls=1") &&
          message.includes("results=0") &&
          message.includes("authenticated=yes") &&
          message.includes("outcome=rate_limited"),
      ),
    );
    assert.ok(
      messages.some(
        (message) =>
          message.includes("provider_calls=2") &&
          message.includes("results=1") &&
          message.includes("authenticated=no") &&
          message.includes("outcome=rate_limited"),
      ),
    );
  });

  test("keeps supported results when a batch also contains an unsupported command", async () => {
    const session = new FakeExaSession(false, () =>
      searchResult("Example", "https://example.com"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });

    const response = await adapter.execute(
      request("mixed", {
        search_query: [{ q: "facts" }],
        weather: [{ location: "Miami, FL" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(session.calls.length, 1);
    assert.strictEqual(response.results.length, 1);
    assert.match(response.output, /\[turn0search0\]/);
    assert.match(response.output, /unsupported_command: weather/);
  });

  test("validates malformed requests and enforces complete UTF-8 output sections", async () => {
    const adapter = createStandaloneSearch({
      client: createClient(
        new FakeExaSession(false, () =>
          searchResult(
            "中文结果",
            "https://example.com",
            "这是很长的搜索结果证据".repeat(100),
          ),
        ),
      ),
    });
    await assert.rejects(
      adapter.execute(
        request("invalid", {
          search_query: [{ q: "" }],
        }),
        new AbortController().signal,
      ),
      CodexSearchRequestValidationError,
    );

    const response = await adapter.execute(
      {
        ...request("bounded", {
          search_query: [{ q: "facts" }],
        }),
        max_output_tokens: 25,
      },
      new AbortController().signal,
    );
    assert.strictEqual(codexOutputByteBudget(25), 25);
    assert.ok(new TextEncoder().encode(response.output).byteLength <= 25);
    assert.strictEqual(response.results.length, 0);
    assert.doesNotMatch(response.output, /\[turn0search0\]/);
  });

  test("does not store references for results omitted by the output budget", async () => {
    let fetchCalls = 0;
    const session = new FakeExaSession(false, (name) => {
      if (name === "web_fetch_exa") {
        fetchCalls++;
      }
      return searchResult("Example", "https://example.com/result");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    const search = await adapter.execute(
      {
        ...request("invisible-reference", {
          search_query: [{ q: "facts" }],
        }),
        max_output_tokens: 80,
      },
      new AbortController().signal,
    );
    const opened = await adapter.execute(
      request("invisible-reference", {
        open: [{ ref_id: "turn0search0" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(search.results.length, 0);
    assert.strictEqual(fetchCalls, 0);
    assert.match(opened.output, /unknown_reference/);
  });

  test("does not store fetch references omitted by the output budget", async () => {
    let fetchCalls = 0;
    const session = new FakeExaSession(false, (name) => {
      if (name === "web_fetch_exa") {
        fetchCalls++;
        return {
          content: [{ type: "text", text: "Fetched page content" }],
        };
      }
      return searchResult("Example", "https://example.com/result");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    await adapter.execute(
      request("invisible-fetch-reference", {
        search_query: [{ q: "facts" }],
      }),
      new AbortController().signal,
    );
    const opened = await adapter.execute(
      {
        ...request("invisible-fetch-reference", {
          open: [{ ref_id: "turn0search0" }],
        }),
        max_output_tokens: 1,
      },
      new AbortController().signal,
    );
    const found = await adapter.execute(
      request("invisible-fetch-reference", {
        find: [{ ref_id: "turn1fetch0", pattern: "content" }],
      }),
      new AbortController().signal,
    );

    assert.strictEqual(opened.output, "");
    assert.strictEqual(fetchCalls, 1);
    assert.match(found.output, /unknown_reference/);
  });

  test("commits only references selected by final prioritized packing", async () => {
    const session = new FakeExaSession(false, (name) =>
      name === "web_fetch_exa"
        ? { content: [{ type: "text", text: "Fetched content" }] }
        : searchResult("Result", "https://example.com/result"),
    );
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    await adapter.execute(
      request("packed-references", {
        search_query: [{ q: "initial" }],
      }),
      new AbortController().signal,
    );
    const packed = await adapter.execute(
      {
        ...request("packed-references", {
          search_query: [{ q: "next" }],
          open: [{ ref_id: "turn0search0" }],
        }),
        max_output_tokens: 200,
      },
      new AbortController().signal,
    );
    const hiddenFetch = await adapter.execute(
      request("packed-references", {
        open: [{ ref_id: "turn1fetch0" }],
      }),
      new AbortController().signal,
    );

    assert.match(packed.output, /Reference: turn1fetch0/);
    assert.deepStrictEqual(packed.results, []);
    assert.match(hiddenFetch.output, /Fetched content/);
  });

  test("does not commit staged search references when a later operation fails", async () => {
    const session = new FakeExaSession(false, (name) => {
      if (name === "web_fetch_exa") {
        throw new ExaMcpError("provider", "fetch failed");
      }
      return searchResult("Result", "https://example.com/result");
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    const failed = await adapter.execute(
      request("failed-staged-references", {
        search_query: [{ q: "facts" }],
        open: [{ ref_id: "https://example.com/page" }],
      }),
      new AbortController().signal,
    );
    const hiddenSearch = await adapter.execute(
      request("failed-staged-references", {
        open: [{ ref_id: "turn0search0" }],
      }),
      new AbortController().signal,
    );

    assert.match(failed.output, /provider_error/);
    assert.match(hiddenSearch.output, /unknown_reference/);
  });

  test("expires and evicts bounded reference state", async () => {
    let now = new Date("2026-08-31T12:00:00.000Z");
    const session = new FakeExaSession(false, (_name, args) => ({
      results: Array.from({ length: 5 }, (_, index) => ({
        title: `${args.query}-${index}`,
        url: `https://example.com/${args.query}/${index}`,
      })),
    }));
    const expiring = createStandaloneSearch({
      client: createClient(session),
      now: () => now,
    });
    await expiring.execute(
      request("expired-references", {
        search_query: [{ q: "initial" }],
      }),
      new AbortController().signal,
    );
    now = new Date(now.getTime() + 31 * 60 * 1_000);
    const expired = await expiring.execute(
      request("expired-references", {
        open: [{ ref_id: "turn0search0" }],
      }),
      new AbortController().signal,
    );

    const evicting = createStandaloneSearch({
      client: createClient(session),
    });
    for (let index = 0; index < 13; index++) {
      await evicting.execute(
        request("evicted-references", {
          search_query: [{ q: `query-${index}` }],
        }),
        new AbortController().signal,
      );
    }
    const evicted = await evicting.execute(
      request("evicted-references", {
        open: [{ ref_id: "turn0search0" }],
      }),
      new AbortController().signal,
    );

    assert.match(expired.output, /unknown_reference/);
    assert.match(evicted.output, /unknown_reference/);
  });

  test("protects reused visible references during commit-time eviction", async () => {
    const firstUrl = "https://example.com/query-0/0";
    const session = new FakeExaSession(false, (name, args) => {
      if (name === "web_fetch_exa") {
        return { content: [{ type: "text", text: "Protected page" }] };
      }
      if (args.query === "reuse") {
        return {
          results: [
            { title: "Existing", url: firstUrl },
            { title: "New", url: "https://example.com/new" },
          ],
        };
      }
      return {
        results: Array.from({ length: 4 }, (_, index) => ({
          title: `${args.query}-${index}`,
          url: `https://example.com/${args.query}/${index}`,
        })),
      };
    });
    const adapter = createStandaloneSearch({
      client: createClient(session),
    });
    for (let index = 0; index < 16; index++) {
      await adapter.execute(
        request("protected-eviction", {
          search_query: [{ q: `query-${index}` }],
        }),
        new AbortController().signal,
      );
    }
    const reused = await adapter.execute(
      request("protected-eviction", {
        search_query: [{ q: "reuse" }],
      }),
      new AbortController().signal,
    );
    const opened = await adapter.execute(
      request("protected-eviction", {
        open: [{ ref_id: "turn0search0" }],
      }),
      new AbortController().signal,
    );

    assert.match(reused.output, /\[turn0search0\]/);
    assert.match(opened.output, /Protected page/);
  });

  suite("route", () => {
    const createApp = () => {
      const session = new FakeExaSession(false, () =>
        searchResult("Example", "https://example.com"),
      );
      const app = new OpenAPIHono();
      registerCodexSearchRoutes(app, {
        codexSearch: createStandaloneSearch({
          client: createClient(session),
        }),
      });
      app.doc("/openapi.json", {
        openapi: "3.0.0",
        info: { title: "Test", version: "1" },
      });
      return app;
    };

    test("mounts the endpoint and documents experimental compatibility", async () => {
      const app = createApp();
      const response = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          request("route", {
            search_query: [{ q: "facts" }],
          }),
        ),
      });
      const document = (await (
        await app.request("/openapi.json")
      ).json()) as Record<string, unknown>;

      assert.strictEqual(response.status, 200);
      assert.ok(
        Object.hasOwn(
          document.paths as Record<string, unknown>,
          "/v1/alpha/search",
        ),
      );
      assert.match(JSON.stringify(document), /experimental/i);
    });

    test("returns OpenAI-style 400 responses for malformed and oversized bodies", async () => {
      const app = createApp();
      const malformed = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      const textPlain = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json",
      });
      const empty = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "",
      });
      const oversized = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "large",
          model: "gpt-5.6",
          commands: { search_query: [{ q: "x".repeat(300_000) }] },
        }),
      });
      const invalidRecency = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          request("invalid-recency", {
            search_query: [{ q: "facts", recency: Number.MAX_SAFE_INTEGER }],
          }),
        ),
      });

      assert.strictEqual(malformed.status, 400);
      assert.strictEqual(textPlain.status, 400);
      assert.strictEqual(empty.status, 400);
      assert.strictEqual(oversized.status, 400);
      assert.strictEqual(invalidRecency.status, 400);
      assert.strictEqual(
        ((await malformed.json()) as { error: { type: string } }).error.type,
        "invalid_request_error",
      );
      for (const response of [textPlain, empty]) {
        assert.strictEqual(
          ((await response.json()) as { error: { type: string } }).error.type,
          "invalid_request_error",
        );
      }
      assert.strictEqual(
        ((await oversized.json()) as { error: { type: string } }).error.type,
        "invalid_request_error",
      );
      assert.strictEqual(
        (
          (await invalidRecency.json()) as {
            error: { param: string };
          }
        ).error.param,
        "commands.search_query.0.recency",
      );
    });

    test("keeps OpenAI authentication middleware in front of the route", async () => {
      const session = new FakeExaSession(false, () =>
        searchResult("Example", "https://example.com"),
      );
      const app = new OpenAPIHono();
      app.use(
        "*",
        createOpenAIAuthMiddleware(() => "secret"),
      );
      registerCodexSearchRoutes(app, {
        codexSearch: createStandaloneSearch({
          client: createClient(session),
        }),
      });
      const response = await app.request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          request("auth", {
            search_query: [{ q: "facts" }],
          }),
        ),
      });

      assert.strictEqual(response.status, 401);
      assert.strictEqual(session.calls.length, 0);
    });

    test("maps operational failures to 200 and programming errors to 500", async () => {
      const createFailureApp = (error: Error) => {
        const app = new OpenAPIHono();
        registerCodexSearchRoutes(app, {
          codexSearch: createStandaloneSearch({
            client: createClient(
              new FakeExaSession(false, () => {
                throw error;
              }),
            ),
          }),
        });
        return app;
      };
      const body = JSON.stringify(
        request("route-failure", {
          search_query: [{ q: "facts" }],
        }),
      );
      const operational = await createFailureApp(
        new ExaMcpError("rate_limited", "limited", 429),
      ).request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const internal = await createFailureApp(
        new Error("programming error"),
      ).request("/v1/alpha/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      assert.strictEqual(operational.status, 200);
      assert.match(await operational.text(), /rate_limited/);
      assert.strictEqual(internal.status, 500);
    });
  });

  suite("Exa standalone search transport", () => {
    test("sends authenticated advanced searches without a text request", async () => {
      let url = "";
      let mcpRequests = 0;
      let headers = new Headers();
      let body: Record<string, unknown> = {};
      const client = new ExaMcpClient({
        endpoint: "https://mcp.test",
        searchEndpoint: "https://search.test/search",
        getApiKey: async () => "secret",
        fetch: async (input, init) => {
          url = String(input);
          headers = new Headers(init?.headers);
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if (url === "https://mcp.test") {
            mcpRequests++;
            const requestBody = body as { id?: number; method?: string };
            if (requestBody.method === "notifications/initialized") {
              return new Response(null, { status: 202 });
            }
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: requestBody.id,
                result: { protocolVersion: "2025-03-26" },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({ results: [] }), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const session = await client.createSession(new AbortController().signal);

      await session.searchAdvanced(
        {
          query: "facts",
          numResults: 3,
          highlightsMaxCharacters: 1_200,
          includeDomains: ["example.com"],
          maxAgeHours: -1,
        },
        new AbortController().signal,
      );

      assert.strictEqual(url, "https://search.test/search");
      assert.strictEqual(mcpRequests, 0);
      assert.strictEqual(headers.get("x-api-key"), "secret");
      assert.deepStrictEqual(body.contents, {
        highlights: { maxCharacters: 1_200 },
        maxAgeHours: -1,
      });
      assert.strictEqual(JSON.stringify(body).includes('"text"'), false);
    });

    test("dispatches anonymous advanced MCP and preserves policy across a rate-limit retry", async () => {
      const toolCalls: ToolCall[] = [];
      let discoveries = 0;
      const client = new ExaMcpClient({
        endpoint: "https://mcp.test",
        getApiKey: async () => undefined,
        fetch: async (input, init) => {
          assert.strictEqual(String(input), "https://mcp.test");
          const headers = new Headers(init?.headers);
          assert.strictEqual(headers.has("x-api-key"), false);
          assert.strictEqual(headers.has("authorization"), false);
          assert.doesNotMatch(String(init?.body), /private conversation/);
          const body = JSON.parse(String(init?.body));
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          let result: unknown;
          if (body.method === "initialize") {
            result = { protocolVersion: "2025-03-26" };
          } else if (body.method === "tools/list") {
            discoveries++;
            result = { tools: [{ name: "web_search_advanced_exa" }] };
          } else {
            assert.strictEqual(body.method, "tools/call");
            toolCalls.push({
              name: body.params.name,
              args: body.params.arguments,
            });
            if (toolCalls.length === 1) {
              return new Response(null, {
                status: 429,
                headers: { "retry-after": "0" },
              });
            }
            result = searchResult("Example", "https://example.com/result");
          }
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
            { headers: { "content-type": "application/json" } },
          );
        },
      });
      const adapter = createStandaloneSearch({ client });

      const response = await adapter.execute(
        request(
          "anonymous-mcp",
          { search_query: [{ q: "facts", domains: ["example.com"] }] },
          { external_web_access: false },
        ),
        new AbortController().signal,
      );

      assert.strictEqual(discoveries, 1);
      assert.strictEqual(toolCalls.length, 2);
      assert.deepStrictEqual(toolCalls[0], {
        name: "web_search_advanced_exa",
        args: {
          query: "facts",
          numResults: 5,
          includeDomains: ["example.com"],
          highlightsMaxCharacters: 1_200,
          maxAgeHours: -1,
          textMaxCharacters: 1,
          enableHighlights: true,
        },
      });
      assert.deepStrictEqual(toolCalls[1], toolCalls[0]);
      assert.strictEqual(response.results[0].snippet, "Example evidence");
    });

    test("honors cancellation while retrieving an API key", async () => {
      let fetches = 0;
      const client = new ExaMcpClient({
        getApiKey: () => new Promise(() => {}),
        fetch: async () => {
          fetches++;
          throw new Error("Unexpected fetch");
        },
      });
      const controller = new AbortController();
      const session = client.createSession(controller.signal);
      controller.abort(new Error("client disconnected"));

      await assert.rejects(
        session,
        (error) =>
          error instanceof ExaMcpError && error.category === "cancelled",
      );
      assert.strictEqual(fetches, 0);
    });

    test("classifies malformed JSON-RPC envelopes as protocol errors", async () => {
      const session = new ExaMcpSession(
        "https://mcp.test",
        async () =>
          new Response("null", {
            headers: { "content-type": "application/json" },
          }),
        undefined,
      );

      await assert.rejects(
        session.callTool("web_search_exa", {}, new AbortController().signal),
        (error) =>
          error instanceof ExaMcpError && error.category === "protocol",
      );
    });

    test("classifies HTTP 408 and 504 as timeouts", async () => {
      for (const status of [408, 504]) {
        const session = new ExaMcpSession(
          "https://mcp.test",
          async () => new Response(null, { status }),
          "secret",
          "https://search.test/search",
        );

        await assert.rejects(
          session.searchAdvanced(
            {
              query: "facts",
              numResults: 3,
              highlightsMaxCharacters: 1_200,
            },
            new AbortController().signal,
          ),
          (error) =>
            error instanceof ExaMcpError &&
            error.category === "timeout" &&
            error.status === status,
        );
      }
    });

    test("preserves cancellation while reading a Search API response", async () => {
      const abortController = new AbortController();
      const session = new ExaMcpSession(
        "https://mcp.test",
        async (_input, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener(
                  "abort",
                  () => controller.error(new Error("aborted")),
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        "secret",
        "https://search.test/search",
      );
      const result = session.searchAdvanced(
        {
          query: "facts",
          numResults: 3,
          highlightsMaxCharacters: 1_200,
        },
        abortController.signal,
      );
      setTimeout(
        () => abortController.abort(new Error("client disconnected")),
        0,
      );

      await assert.rejects(
        result,
        (error) =>
          error instanceof ExaMcpError && error.category === "cancelled",
      );
    });

    test("retries a JSON-RPC rate limit once when retry metadata permits", async () => {
      let toolAttempts = 0;
      const session = new ExaMcpSession(
        "https://mcp.test",
        async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            id?: number;
            method?: string;
          };
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          if (body.method === "initialize") {
            return new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "2025-03-26" },
              }),
              { headers: { "content-type": "application/json" } },
            );
          }
          toolAttempts++;
          return new Response(
            JSON.stringify(
              toolAttempts === 1
                ? {
                    jsonrpc: "2.0",
                    id: body.id,
                    error: {
                      code: -32_000,
                      message: "Rate limited",
                      data: { status: 429, retryAfterMs: 0 },
                    },
                  }
                : {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { content: [] },
                  },
            ),
            { headers: { "content-type": "application/json" } },
          );
        },
        undefined,
      );

      await session.callTool(
        "web_search_exa",
        {},
        new AbortController().signal,
      );

      assert.strictEqual(toolAttempts, 2);
    });

    test("preserves JSON-RPC error categories, status, and retry metadata", async () => {
      const fixtures = [
        {
          error: {
            code: -32_000,
            message: "Rate limit exceeded",
            data: { statusCode: 429, retryAfterMs: 1_500 },
          },
          category: "rate_limited",
          status: 429,
          retryAfterMs: 1_500,
        },
        {
          error: {
            code: -32_000,
            message: "Unauthorized",
            data: { status: 401 },
          },
          category: "authentication",
          status: 401,
          retryAfterMs: undefined,
        },
        {
          error: {
            code: -32_000,
            message: "Provider unavailable",
            data: { httpStatus: 503 },
          },
          category: "provider",
          status: 503,
          retryAfterMs: undefined,
        },
      ] as const;

      for (const fixture of fixtures) {
        const session = new ExaMcpSession(
          "https://mcp.test",
          async () =>
            new Response(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                error: fixture.error,
              }),
              { headers: { "content-type": "application/json" } },
            ),
          undefined,
        );

        await assert.rejects(
          session.callTool("web_search_exa", {}, new AbortController().signal),
          (error) =>
            error instanceof ExaMcpError &&
            error.category === fixture.category &&
            error.status === fixture.status &&
            error.retryAfterMs === fixture.retryAfterMs &&
            error.jsonRpcCode === -32_000,
        );
      }
    });
  });
});
