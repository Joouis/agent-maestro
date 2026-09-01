const EXA_MCP_BASE_ENDPOINT = "https://mcp.exa.ai/mcp";
const EXA_SEARCH_API_ENDPOINT = "https://api.exa.ai/search";
const MCP_PROTOCOL_VERSION = "2025-03-26";
const MAX_RATE_LIMIT_RETRY_DELAY_MS = 2_000;

export const EXA_SEARCH_TOOLS = [
  "web_search_exa",
  "web_search_advanced_exa",
] as const;
export const EXA_CODEX_TOOLS = [...EXA_SEARCH_TOOLS, "web_fetch_exa"] as const;

export type ExaMcpErrorCategory =
  | "authentication"
  | "cancelled"
  | "protocol"
  | "provider"
  | "rate_limited"
  | "timeout";

export class ExaMcpError extends Error {
  constructor(
    public readonly category: ExaMcpErrorCategory,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly jsonRpcCode?: number,
  ) {
    super(message);
    this.name = "ExaMcpError";
  }
}

interface JsonRpcResponse {
  error?: unknown;
  id?: number | string | null;
  method?: string;
  result?: unknown;
}

export interface ExaMcpClientOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  getApiKey?: () => Promise<string | undefined>;
  searchEndpoint?: string;
  tools?: readonly string[];
}

export interface ExaAdvancedSearchApiRequest {
  excludeDomains?: string[];
  highlightsMaxCharacters: number;
  includeDomains?: string[];
  maxAgeHours?: number;
  numResults: number;
  query: string;
  startPublishedDate?: string;
  userLocation?: string;
}

export interface ExaMcpSessionClient {
  readonly authenticated: boolean;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  listTools(signal: AbortSignal): Promise<string[]>;
  searchAdvanced(
    request: ExaAdvancedSearchApiRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface ExaMcpClientFactory {
  createSession(signal: AbortSignal): Promise<ExaMcpSessionClient>;
}

const endpointForTools = (tools: readonly string[]): string => {
  const url = new URL(EXA_MCP_BASE_ENDPOINT);
  url.searchParams.set("tools", tools.join(","));
  return url.toString();
};

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : undefined;
};

const errorFromStatus = (
  response: Response,
  service = "Exa MCP",
): ExaMcpError => {
  const status = response.status;
  const category: ExaMcpErrorCategory =
    status === 401 || status === 403
      ? "authentication"
      : status === 429
        ? "rate_limited"
        : status === 408 || status === 504
          ? "timeout"
          : "provider";
  return new ExaMcpError(
    category,
    `${service} request failed with status ${status}`,
    status,
    parseRetryAfter(response.headers.get("retry-after")),
  );
};

const readNumericField = (
  record: Record<string, unknown>,
  names: readonly string[],
): number | undefined => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (
      typeof value === "string" &&
      value.trim() &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
  }
  return undefined;
};

const jsonRpcError = (value: unknown): ExaMcpError => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new ExaMcpError("protocol", "Exa MCP protocol request failed");
  }
  const error = value as Record<string, unknown>;
  const data =
    error.data && typeof error.data === "object" && !Array.isArray(error.data)
      ? (error.data as Record<string, unknown>)
      : {};
  const status =
    readNumericField(error, ["status", "statusCode", "httpStatus"]) ??
    readNumericField(data, ["status", "statusCode", "httpStatus"]);
  const retryAfterMsValue =
    readNumericField(error, ["retryAfterMs", "retry_after_ms"]) ??
    readNumericField(data, ["retryAfterMs", "retry_after_ms"]) ??
    (() => {
      const seconds =
        readNumericField(error, ["retryAfter", "retry_after"]) ??
        readNumericField(data, ["retryAfter", "retry_after"]);
      return seconds === undefined ? undefined : Math.round(seconds * 1_000);
    })();
  const retryAfterMs =
    retryAfterMsValue !== undefined && retryAfterMsValue >= 0
      ? retryAfterMsValue
      : undefined;
  const message = [
    typeof error.message === "string" ? error.message : "",
    typeof data.message === "string" ? data.message : "",
    typeof data.error === "string" ? data.error : "",
  ].join(" ");
  const code = readNumericField(error, ["code"]);
  const category: ExaMcpErrorCategory =
    status === 401 ||
    status === 403 ||
    /unauthorized|forbidden|api key/i.test(message)
      ? "authentication"
      : status === 429 || /rate.?limit|too many requests/i.test(message)
        ? "rate_limited"
        : status === 408 || status === 504 || /timed out|timeout/i.test(message)
          ? "timeout"
          : status !== undefined ||
              (code !== undefined && (code < -32700 || code > -32600))
            ? "provider"
            : "protocol";
  return new ExaMcpError(
    category,
    `Exa MCP ${category.replace("_", " ")} error`,
    status,
    retryAfterMs,
    code,
  );
};

export const exaMcpErrorFromAbortSignal = (
  signal: AbortSignal,
): ExaMcpError => {
  if (signal.reason instanceof ExaMcpError) {
    return signal.reason;
  }
  const reason =
    signal.reason instanceof Error
      ? signal.reason.message
      : String(signal.reason);
  const timedOut = /timed out|timeout/i.test(reason);
  return new ExaMcpError(
    timedOut ? "timeout" : "cancelled",
    timedOut ? "Exa MCP request timed out" : "Exa MCP request was cancelled",
  );
};

const waitWithAbortSignal = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(exaMcpErrorFromAbortSignal(signal));
      return;
    }
    const onAbort = () => {
      reject(exaMcpErrorFromAbortSignal(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });

const waitForRetry = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(exaMcpErrorFromAbortSignal(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(exaMcpErrorFromAbortSignal(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timeout.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });

const contentText = (value: unknown): string[] => {
  if (!value || typeof value !== "object") {
    return [];
  }
  const content = (value as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const text = (item as Record<string, unknown>).text;
    return typeof text === "string" ? [text] : [];
  });
};

const toolError = (value: unknown): ExaMcpError | undefined => {
  if (
    !value ||
    typeof value !== "object" ||
    (value as Record<string, unknown>).isError !== true
  ) {
    return undefined;
  }
  const text = contentText(value).join("\n");
  if (/rate limit|status\s*429|\(429\)/i.test(text)) {
    return new ExaMcpError(
      "rate_limited",
      "Exa MCP tool was rate limited",
      429,
    );
  }
  if (/unauthorized|forbidden|api key|status\s*40[13]|\(40[13]\)/i.test(text)) {
    return new ExaMcpError(
      "authentication",
      "Exa MCP tool authentication failed",
    );
  }
  if (/timed out|timeout/i.test(text)) {
    return new ExaMcpError("timeout", "Exa MCP tool timed out");
  }
  return new ExaMcpError("provider", "Exa MCP tool returned an error");
};

const parseJsonRpcMessages = (value: unknown): JsonRpcResponse[] => {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new ExaMcpError(
        "protocol",
        "Exa MCP returned an invalid JSON-RPC envelope",
      );
    }
    const record = candidate as Record<string, unknown>;
    if (
      record.jsonrpc !== "2.0" ||
      (record.id !== undefined &&
        record.id !== null &&
        typeof record.id !== "number" &&
        typeof record.id !== "string") ||
      (record.id === undefined && typeof record.method !== "string") ||
      (record.id !== undefined &&
        record.result === undefined &&
        record.error === undefined) ||
      (record.result !== undefined && record.error !== undefined)
    ) {
      throw new ExaMcpError(
        "protocol",
        "Exa MCP returned an invalid JSON-RPC envelope",
      );
    }
    return {
      ...(record.id !== undefined && {
        id: record.id as number | string | null,
      }),
      ...(typeof record.method === "string" && { method: record.method }),
      ...(record.result !== undefined && { result: record.result }),
      ...(record.error !== undefined && { error: record.error }),
    };
  });
};

export const parseEventStream = (body: string): JsonRpcResponse[] => {
  const responses: JsonRpcResponse[] = [];
  const events = body.replace(/\r\n/g, "\n").split("\n\n");

  for (const event of events) {
    const data = event
      .split("\n")
      .flatMap((line) => {
        const match = /^data(?:: ?(.*))?$/.exec(line);
        return match ? [match[1] ?? ""] : [];
      })
      .join("\n");
    if (!data.trim() || data.trim() === "[DONE]") {
      continue;
    }

    try {
      responses.push(...parseJsonRpcMessages(JSON.parse(data)));
    } catch {
      throw new ExaMcpError(
        "protocol",
        "Exa MCP returned an invalid event stream",
      );
    }
  }

  return responses;
};

export const collectExaResultCandidates = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.results)) {
    return record.results;
  }
  if (record.structuredContent) {
    const structured = collectExaResultCandidates(record.structuredContent);
    if (structured.length > 0) {
      return structured;
    }
  }

  const candidates: unknown[] = [];
  for (const text of contentText(value)) {
    try {
      candidates.push(...collectExaResultCandidates(JSON.parse(text)));
      continue;
    } catch {
      const sections = text.split(/\n\s*---\s*\n/);
      for (const section of sections) {
        const title = section.match(/^Title:\s*(.+)$/m)?.[1];
        const url = section.match(/^URL:\s*(.+)$/m)?.[1];
        if (!url) {
          continue;
        }
        const publishedDate = section.match(/^Published:\s*(.+)$/m)?.[1];
        const snippet = section.match(
          /^(?:Highlights|Text|Snippet):\s*([\s\S]+)$/m,
        )?.[1];
        candidates.push({ title, url, publishedDate, snippet });
      }
    }
  }
  return candidates;
};

export const collectExaContentText = (value: unknown): string =>
  contentText(value).join("\n\n");

export class ExaMcpSession implements ExaMcpSessionClient {
  private initialized = false;
  private initializationPromise: Promise<void> | undefined;
  private nextId = 1;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private sessionId: string | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch,
    private readonly apiKey: string | undefined,
    private readonly searchEndpoint = EXA_SEARCH_API_ENDPOINT,
  ) {}

  get authenticated(): boolean {
    return this.apiKey !== undefined;
  }

  async initialize(signal: AbortSignal): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initializationPromise ??= this.initializeMcp(signal);
    try {
      await this.initializationPromise;
      this.initialized = true;
    } finally {
      if (!this.initialized) {
        this.initializationPromise = undefined;
      }
    }
  }

  private async initializeMcp(signal: AbortSignal): Promise<void> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-maestro", version: "1.0.0" },
      },
      signal,
    );
    if (result && typeof result === "object") {
      const negotiatedVersion = (result as Record<string, unknown>)
        .protocolVersion;
      if (typeof negotiatedVersion === "string") {
        this.protocolVersion = negotiatedVersion;
      }
    }
    await this.notification("notifications/initialized", signal);
  }

  async listTools(signal: AbortSignal): Promise<string[]> {
    await this.initialize(signal);
    const result = await this.request("tools/list", {}, signal);
    if (!result || typeof result !== "object") {
      throw new ExaMcpError(
        "protocol",
        "Exa MCP returned an invalid tool list",
      );
    }
    const tools = (result as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) {
      throw new ExaMcpError(
        "protocol",
        "Exa MCP returned an invalid tool list",
      );
    }
    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object") {
        return [];
      }
      const name = (tool as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.initialize(signal);
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      signal,
    );
    const error = toolError(result);
    if (error) {
      throw error;
    }
    return result;
  }

  async searchAdvanced(
    request: ExaAdvancedSearchApiRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new ExaMcpError(
        "authentication",
        "Exa advanced search requires an API key",
      );
    }
    const { highlightsMaxCharacters, maxAgeHours, ...searchParameters } =
      request;
    const body = {
      ...searchParameters,
      type: "auto",
      contents: {
        highlights: { maxCharacters: highlightsMaxCharacters },
        ...(maxAgeHours !== undefined && { maxAgeHours }),
      },
    };
    return this.withRateLimitRetry(async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(this.searchEndpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        if (signal.aborted) {
          throw exaMcpErrorFromAbortSignal(signal);
        }
        throw new ExaMcpError("provider", "Exa Search API request failed");
      }
      if (!response.ok) {
        throw errorFromStatus(response, "Exa Search API");
      }
      try {
        return await response.json();
      } catch {
        if (signal.aborted) {
          throw exaMcpErrorFromAbortSignal(signal);
        }
        throw new ExaMcpError(
          "protocol",
          "Exa Search API returned invalid JSON",
        );
      }
    }, signal);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };
    return this.withRateLimitRetry(async () => {
      const response = await this.send(body, signal);
      const message = response.find((candidate) => candidate.id === id);
      if (!message) {
        throw new ExaMcpError("protocol", "Exa MCP protocol request failed");
      }
      if (message.error !== undefined) {
        throw jsonRpcError(message.error);
      }
      return message.result;
    }, signal);
  }

  private async notification(
    method: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.withRateLimitRetry(
      () => this.send({ jsonrpc: "2.0", method }, signal),
      signal,
    );
  }

  private async send(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<JsonRpcResponse[]> {
    try {
      return await this.sendOnce(body, signal);
    } catch (error) {
      if (signal.aborted) {
        throw exaMcpErrorFromAbortSignal(signal);
      }
      if (error instanceof ExaMcpError) {
        throw error;
      }
      throw new ExaMcpError("provider", "Exa MCP request failed");
    }
  }

  private async withRateLimitRetry<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof ExaMcpError) ||
        error.category !== "rate_limited" ||
        error.retryAfterMs === undefined ||
        error.retryAfterMs > MAX_RATE_LIMIT_RETRY_DELAY_MS
      ) {
        throw error;
      }
      await waitForRetry(error.retryAfterMs, signal);
      return operation();
    }
  }

  private async sendOnce(
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<JsonRpcResponse[]> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.protocolVersion,
    };
    if (this.sessionId) {
      headers["MCP-Session-Id"] = this.sessionId;
    }
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw errorFromStatus(response);
    }

    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    if (response.status === 202 || response.status === 204) {
      return [];
    }

    const responseBody = await response.text();
    if (!responseBody.trim()) {
      return [];
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      return parseEventStream(responseBody);
    }
    try {
      return parseJsonRpcMessages(JSON.parse(responseBody));
    } catch {
      throw new ExaMcpError("protocol", "Exa MCP returned invalid JSON");
    }
  }
}

export class ExaMcpClient implements ExaMcpClientFactory {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getApiKey: () => Promise<string | undefined>;
  private readonly searchEndpoint: string;

  constructor(options: ExaMcpClientOptions = {}) {
    this.endpoint =
      options.endpoint ?? endpointForTools(options.tools ?? EXA_SEARCH_TOOLS);
    this.fetchImpl = options.fetch ?? fetch;
    this.getApiKey = options.getApiKey ?? (async () => undefined);
    this.searchEndpoint = options.searchEndpoint ?? EXA_SEARCH_API_ENDPOINT;
  }

  async createSession(signal: AbortSignal): Promise<ExaMcpSession> {
    if (signal.aborted) {
      throw exaMcpErrorFromAbortSignal(signal);
    }
    const apiKey =
      (await waitWithAbortSignal(this.getApiKey(), signal))?.trim() ||
      undefined;
    if (signal.aborted) {
      throw exaMcpErrorFromAbortSignal(signal);
    }
    const session = new ExaMcpSession(
      this.endpoint,
      this.fetchImpl,
      apiKey,
      this.searchEndpoint,
    );
    return session;
  }
}
