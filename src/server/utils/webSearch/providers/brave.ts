import {
  WebSearchError,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResult,
} from "../types";

interface BraveResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
      page_age?: string;
    }>;
  };
}

export class BraveSearchProvider implements WebSearchProvider {
  readonly name = "brave";

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

    const params = new URLSearchParams({
      q: query,
      count: String(Math.min(opts.maxResults, 20)),
    });

    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": this.apiKey,
          },
          signal: controller.signal,
        },
      );

      if (res.status === 429) {
        throw new WebSearchError("Rate limited", "too_many_requests");
      }
      if (!res.ok) {
        throw new WebSearchError(`Brave returned ${res.status}`, "unavailable");
      }

      const data = (await res.json()) as BraveResponse;
      const normalize = (d: string) =>
        d.toLowerCase().replace(/^\.+/, "").replace(/\/+$/, "");
      const matchesDomain = (host: string, domain: string) =>
        host === domain || host.endsWith("." + domain);

      const allowed = opts.allowedDomains
        ? opts.allowedDomains.map(normalize)
        : null;
      const blocked = opts.blockedDomains
        ? opts.blockedDomains.map(normalize)
        : null;

      return (data.web?.results ?? [])
        .filter((r) => {
          try {
            const host = new URL(r.url).hostname.toLowerCase();
            if (allowed && !allowed.some((d) => matchesDomain(host, d))) {
              return false;
            }
            if (blocked && blocked.some((d) => matchesDomain(host, d))) {
              return false;
            }
            return true;
          } catch {
            return false;
          }
        })
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
          publishedDate: r.page_age,
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
