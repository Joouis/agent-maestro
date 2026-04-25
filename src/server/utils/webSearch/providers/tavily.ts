import {
  WebSearchError,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResult,
} from "../types";

interface TavilyResponse {
  results?: Array<{
    title: string;
    url: string;
    content: string;
    score?: number;
    published_date?: string;
  }>;
  error?: string;
}

export class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs: number,
  ) {}

  async search(
    query: string,
    opts: WebSearchOptions,
  ): Promise<WebSearchResult[]> {
    if (!query || query.length === 0) {
      throw new WebSearchError("Empty query", "invalid_input");
    }
    if (query.length > 400) {
      throw new WebSearchError("Query too long", "query_too_long");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(opts.maxResults, 20),
          include_domains: opts.allowedDomains,
          exclude_domains: opts.blockedDomains,
          search_depth: "basic",
        }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        throw new WebSearchError("Rate limited", "too_many_requests");
      }
      if (!res.ok) {
        throw new WebSearchError(
          `Tavily returned ${res.status}`,
          "unavailable",
        );
      }

      const data = (await res.json()) as TavilyResponse;
      if (data.error) {
        throw new WebSearchError(data.error, "unavailable");
      }
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedDate: r.published_date,
      }));
    } catch (err) {
      if (err instanceof WebSearchError) {
        throw err;
      }
      if ((err as Error).name === "AbortError") {
        throw new WebSearchError("Search timed out", "unavailable");
      }
      throw new WebSearchError(
        (err as Error).message || "Unknown search error",
        "unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
