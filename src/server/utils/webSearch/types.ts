export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchOptions {
  maxResults: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, opts: WebSearchOptions): Promise<WebSearchResult[]>;
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    public code:
      | "too_many_requests"
      | "invalid_input"
      | "max_uses_exceeded"
      | "query_too_long"
      | "unavailable",
  ) {
    super(message);
    this.name = "WebSearchError";
  }
}
