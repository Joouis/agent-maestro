import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";

// Model resolution must never see a missing model: it used to reach fuzzy
// matching and throw `undefined.toLowerCase()`, surfacing as HTTP 500.
const resolveChatModelClient = async () => {
  throw new Error("model resolution must not run without a model");
};

function createApp(): OpenAPIHono {
  const app = new OpenAPIHono();
  registerAnthropicRoutes(app, { resolveChatModelClient });
  registerOpenaiChatRoutes(app, { resolveChatModelClient });
  return app;
}

const messages = [{ role: "user", content: "hi" }];

const routes: {
  path: string;
  body: Record<string, unknown>;
  assertError: (body: any) => void;
}[] = [
  {
    path: "/v1/messages",
    body: { max_tokens: 10, messages },
    assertError: (body) => {
      assert.strictEqual(body.type, "error");
      assert.strictEqual(body.error.type, "invalid_request_error");
      assert.match(body.error.message, /model/);
    },
  },
  {
    path: "/v1/messages/count_tokens",
    body: { messages },
    assertError: (body) => {
      assert.strictEqual(body.type, "error");
      assert.strictEqual(body.error.type, "invalid_request_error");
      assert.match(body.error.message, /model/);
    },
  },
  {
    path: "/v1/chat/completions",
    body: { messages },
    assertError: (body) => {
      assert.strictEqual(body.error.type, "invalid_request_error");
      assert.strictEqual(body.error.param, "model");
      assert.strictEqual(body.error.code, "missing_required_parameter");
    },
  },
];

suite("Missing model validation", () => {
  for (const { path, body, assertError } of routes) {
    for (const [label, model] of [
      ["missing", undefined],
      ["empty", ""],
      ["non-string", 42],
    ] as const) {
      test(`${path} rejects a ${label} model with 400`, async () => {
        const response = await createApp().request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(model === undefined ? body : { ...body, model }),
        });
        assert.strictEqual(response.status, 400);
        assertError(await response.json());
      });
    }
  }
});
