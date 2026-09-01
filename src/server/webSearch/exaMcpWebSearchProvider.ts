import { logger } from "../../utils/logger";
import {
  ExaMcpClient,
  ExaMcpClientFactory,
  ExaMcpClientOptions,
  collectExaResultCandidates,
  parseEventStream,
} from "./exaMcpClient";
import {
  MAX_WEB_SEARCH_RESULTS,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  normalizeWebSearchResults,
} from "./webSearchProvider";

export { parseEventStream };

export class ExaMcpWebSearchProvider implements WebSearchProvider {
  private readonly client: ExaMcpClientFactory;

  constructor(
    options: ExaMcpClientOptions & { client?: ExaMcpClientFactory } = {},
  ) {
    this.client = options.client ?? new ExaMcpClient(options);
  }

  async search(
    request: WebSearchRequest,
    signal: AbortSignal,
  ): Promise<WebSearchResult[]> {
    const session = await this.client.createSession(signal);
    const advanced =
      request.allowedDomains !== undefined ||
      request.blockedDomains !== undefined ||
      request.userLocation !== undefined;
    const toolName = advanced ? "web_search_advanced_exa" : "web_search_exa";
    logger.info(
      `Exa MCP web search starting | mode: ${advanced ? "advanced" : "simple"} | authenticated: ${session.authenticated ? "yes" : "no"}`,
    );
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
    const results = normalizeWebSearchResults(
      collectExaResultCandidates(toolResult),
    );
    logger.info(`Exa MCP web search completed | results: ${results.length}`);
    return results;
  }
}
