import { OpenAPIHono } from "@hono/zod-openapi";

import { WebSearchProvider } from "../../webSearch/webSearchProvider";
import { registerOpenaiChatRoutes } from "./openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "./openaiResponsesRoutes";

export interface OpenaiRoutesOptions {
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
}
