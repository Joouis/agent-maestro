import { OpenAPIHono } from "@hono/zod-openapi";

import { registerOpenaiChatRoutes } from "./openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "./openaiResponsesRoutes";

export function registerOpenaiRoutes(app: OpenAPIHono) {
  registerOpenaiChatRoutes(app);
  registerOpenaiResponsesRoutes(app);
}
