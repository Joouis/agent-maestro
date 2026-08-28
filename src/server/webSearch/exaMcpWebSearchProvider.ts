import { logger } from "../../utils/logger";
import {
  MAX_WEB_SEARCH_RESULTS,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  normalizeWebSearchResults,
} from "./webSearchProvider";

const EXA_MCP_ENDPOINT =
  "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa";
const MCP_PROTOCOL_VERSION = "2025-03-26";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface ExaMcpProviderOptions {
  getApiKey?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  endpoint?: string;
}

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

    const parsed = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
    responses.push(...(Array.isArray(parsed) ? parsed : [parsed]));
  }

  return responses;
};

const collectResultCandidates = (value: unknown): unknown[] => {
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
    const structured = collectResultCandidates(record.structuredContent);
    if (structured.length > 0) {
      return structured;
    }
  }
  if (!Array.isArray(record.content)) {
    return [];
  }

  const candidates: unknown[] = [];
  for (const content of record.content) {
    if (!content || typeof content !== "object") {
      continue;
    }
    const text = (content as Record<string, unknown>).text;
    if (typeof text !== "string") {
      continue;
    }

    try {
      candidates.push(...collectResultCandidates(JSON.parse(text)));
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

class ExaMcpSession {
  private nextId = 1;
  private protocolVersion = MCP_PROTOCOL_VERSION;
  private sessionId: string | undefined;

  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: typeof fetch,
    private readonly apiKey: string | undefined,
  ) {}

  async initialize(signal: AbortSignal): Promise<void> {
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
    const result = await this.request("tools/list", {}, signal);
    if (!result || typeof result !== "object") {
      throw new Error("Exa MCP returned an invalid tool list");
    }
    const tools = (result as Record<string, unknown>).tools;
    if (!Array.isArray(tools)) {
      throw new Error("Exa MCP returned an invalid tool list");
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
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.send(
      { jsonrpc: "2.0", id, method, params },
      signal,
    );
    const message = response.find((candidate) => candidate.id === id);
    if (!message || message.error !== undefined) {
      throw new Error("Exa MCP protocol request failed");
    }
    return message.result;
  }

  private async notification(
    method: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.send({ jsonrpc: "2.0", method }, signal);
  }

  private async send(
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
      throw new Error(`Exa MCP request failed with status ${response.status}`);
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
    const parsed = JSON.parse(responseBody) as
      | JsonRpcResponse
      | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }
}

export class ExaMcpWebSearchProvider implements WebSearchProvider {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getApiKey: () => Promise<string | undefined>;

  constructor(options: ExaMcpProviderOptions = {}) {
    this.endpoint = options.endpoint ?? EXA_MCP_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
    this.getApiKey = options.getApiKey ?? (async () => undefined);
  }

  async search(
    request: WebSearchRequest,
    signal: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const apiKey = (await this.getApiKey())?.trim() || undefined;
    const session = new ExaMcpSession(this.endpoint, this.fetchImpl, apiKey);
    const advanced =
      request.allowedDomains !== undefined ||
      request.blockedDomains !== undefined ||
      request.userLocation !== undefined;
    const toolName = advanced ? "web_search_advanced_exa" : "web_search_exa";

    logger.info(
      `Exa MCP web search starting | mode: ${advanced ? "advanced" : "simple"} | authenticated: ${apiKey ? "yes" : "no"}`,
    );
    await session.initialize(signal);
    const tools = await session.listTools(signal);
    if (!tools.includes(toolName)) {
      throw new Error(`Exa MCP tool '${toolName}' is unavailable`);
    }

    const args: Record<string, unknown> = {
      query: request.query,
      numResults: Math.min(request.maxResults, MAX_WEB_SEARCH_RESULTS),
    };
    if (advanced) {
      if (request.allowedDomains) {
        args.includeDomains = request.allowedDomains;
      }
      if (request.blockedDomains) {
        args.excludeDomains = request.blockedDomains;
      }
      if (request.userLocation) {
        args.userLocation = request.userLocation.country;
      }
      args.enableHighlights = true;
      args.highlightsMaxCharacters = 1_200;
    }

    const toolResult = await session.callTool(toolName, args, signal);
    if (
      toolResult &&
      typeof toolResult === "object" &&
      (toolResult as Record<string, unknown>).isError === true
    ) {
      throw new Error("Exa search tool returned an error");
    }

    const results = normalizeWebSearchResults(
      collectResultCandidates(toolResult),
    );
    logger.info(`Exa MCP web search completed | results: ${results.length}`);
    return results;
  }
}
