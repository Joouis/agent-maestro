import { OpenAPIHono } from "@hono/zod-openapi";

import { CodexStandaloneWebSearch } from "../../webSearch/codexStandaloneWebSearch";
import { WebSearchProvider } from "../../webSearch/webSearchProvider";
import { registerCodexSearchRoutes } from "./codexSearchRoutes";
import { registerOpenaiChatRoutes } from "./openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "./openaiResponsesRoutes";

export interface OpenaiRoutesOptions {
  codexSearch?: CodexStandaloneWebSearch;
  webSearchProvider?: WebSearchProvider;
}

export function registerOpenaiRoutes(
  app: OpenAPIHono,
  options: OpenaiRoutesOptions = {},
): void {
  registerOpenaiChatRoutes(app);
  registerOpenaiResponsesRoutes(app, {
    webSearchProvider: options.webSearchProvider,
  });
  if (options.codexSearch) {
    registerCodexSearchRoutes(app, { codexSearch: options.codexSearch });
  }
}
