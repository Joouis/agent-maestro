import * as assert from "assert";
import type { Context, Next } from "hono";

import {
  createAnthropicAuthMiddleware,
  createGeminiAuthMiddleware,
  createOpenAIAuthMiddleware,
} from "../server/middleware/authMiddleware";

// Mock Context for testing
function createMockContext(
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
): Context {
  const mockResponse = {
    status: 200,
    body: null as any,
  };

  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      query: (name: string) => query[name],
    },
    json: (body: any, status: number) => {
      mockResponse.status = status;
      mockResponse.body = body;
      return mockResponse as any;
    },
  } as any as Context;
}

// Mock Next function
const createMockNext = (): Next => {
  let called = false;
  const next = (() => {
    called = true;
    return Promise.resolve();
  }) as Next;
  (next as any).wasCalled = () => called;
  return next;
};

suite("Authentication Middleware Test Suite", () => {
  suite("createAnthropicAuthMiddleware", () => {
    test("should allow request when no LLM API key is configured", async () => {
      const getLlmApiKey = () => null;
      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      await middleware(ctx, next);

      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should allow request with valid LLM API key", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ "x-api-key": validKey });
      const next = createMockNext();

      await middleware(ctx, next);

      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should reject request with invalid LLM API key", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ "x-api-key": "invalid-key" });
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.body.type, "error");
      assert.strictEqual(response.body.error.type, "authentication_error");
      assert.strictEqual(response.body.error.message, "Invalid API key");
    });

    test("should reject request with missing LLM API key", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.body.type, "error");
      assert.strictEqual(response.body.error.type, "authentication_error");
    });

    test("should reject request when LLM API key differs by case", async () => {
      const validKey = "ValidLlmApiKey123";
      const getLlmApiKey = () => validKey;
      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ "x-api-key": "validllmapikey123" });
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
    });
  });

  suite("createOpenAIAuthMiddleware", () => {
    test("should allow request when no LLM API key is configured", async () => {
      const getLlmApiKey = () => null;
      const middleware = createOpenAIAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      await middleware(ctx, next);

      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should allow request with valid Bearer token", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createOpenAIAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ authorization: `Bearer ${validKey}` });
      const next = createMockNext();

      await middleware(ctx, next);

      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should reject request with invalid Bearer token", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createOpenAIAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ authorization: "Bearer invalid-key" });
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
      assert.strictEqual(
        response.body.error.message,
        "Incorrect API key provided",
      );
      assert.strictEqual(response.body.error.type, "invalid_request_error");
      assert.strictEqual(response.body.error.code, "invalid_api_key");
    });

    test("should reject request with missing Authorization header", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createOpenAIAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
    });

    test("should reject request with malformed Authorization header", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createOpenAIAuthMiddleware(getLlmApiKey);

      // Missing "Bearer " prefix
      const ctx = createMockContext({ authorization: validKey });
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
    });

    test("should handle Bearer token with extra spaces", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createOpenAIAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({
        authorization: `Bearer  ${validKey}`,
      });
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      // Should fail because of extra space
      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
    });
  });

  suite("createGeminiAuthMiddleware", () => {
    test("should allow request when no LLM API key is configured", async () => {
      const getLlmApiKey = () => null;
      const middleware = createGeminiAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      await middleware(ctx, next);

      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should allow request with valid x-goog-api-key header", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createGeminiAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ "x-goog-api-key": validKey });
      const next = createMockNext();

      await middleware(ctx, next);

      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should reject request with invalid LLM API key in header", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createGeminiAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext({ "x-goog-api-key": "invalid-key" });
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
      assert.strictEqual(response.body.error.code, 401);
      assert.strictEqual(
        response.body.error.message,
        "API key not valid. Please pass a valid API key.",
      );
      assert.strictEqual(response.body.error.status, "UNAUTHENTICATED");
    });

    test("should reject request with missing LLM API key", async () => {
      const validKey = "valid-llm-api-key-123";
      const getLlmApiKey = () => validKey;
      const middleware = createGeminiAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      const response = (await middleware(ctx, next)) as any;

      assert.strictEqual((next as any).wasCalled(), false);
      assert.strictEqual(response.status, 401);
    });
  });

  suite("Integration Tests", () => {
    test("should handle empty string as disabled authentication", async () => {
      const getLlmApiKey = () => "";
      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      const ctx = createMockContext();
      const next = createMockNext();

      await middleware(ctx, next);

      // Empty string is falsy, so should allow through
      assert.strictEqual((next as any).wasCalled(), true);
    });

    test("should handle LLM API key changes at runtime", async () => {
      let currentKey: string | null = "initial-key";
      const getLlmApiKey = () => currentKey;

      const middleware = createAnthropicAuthMiddleware(getLlmApiKey);

      // First request with matching key
      const ctx1 = createMockContext({ "x-api-key": "initial-key" });
      const next1 = createMockNext();
      await middleware(ctx1, next1);
      assert.strictEqual((next1 as any).wasCalled(), true);

      // Change the key
      currentKey = "new-key";

      // Old key should now fail
      const ctx2 = createMockContext({ "x-api-key": "initial-key" });
      const next2 = createMockNext();
      const response2 = (await middleware(ctx2, next2)) as any;
      assert.strictEqual((next2 as any).wasCalled(), false);
      assert.strictEqual(response2.status, 401);

      // New key should work
      const ctx3 = createMockContext({ "x-api-key": "new-key" });
      const next3 = createMockNext();
      await middleware(ctx3, next3);
      assert.strictEqual((next3 as any).wasCalled(), true);

      // Disable authentication
      currentKey = null;

      // Should allow any request now
      const ctx4 = createMockContext({ "x-api-key": "any-key" });
      const next4 = createMockNext();
      await middleware(ctx4, next4);
      assert.strictEqual((next4 as any).wasCalled(), true);
    });
  });
});
