import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { registerAnthropicRoutes } from "../../server/routes/anthropicRoutes";
import { registerGeminiRoutes } from "../../server/routes/geminiRoutes";
import { registerOpenaiChatRoutes } from "../../server/routes/openai/openaiChatRoutes";
import { registerOpenaiResponsesRoutes } from "../../server/routes/openai/openaiResponsesRoutes";
import {
  chatModelsCache,
  isStaleModelHandleError,
  sendWithStaleModelRetry,
} from "../../utils/chatModels";

const MODEL_ID = "gpt-6.1-sol";

// Exact upstream text from VS Code's main-thread `sendChatRequest` when only
// its model cache has dropped the internal ID.
const notRegistered = () =>
  new Error(
    `Chat provider for model copilot/Copilot/${MODEL_ID} is not registered.`,
  );

function textResponse(text: string): vscode.LanguageModelChatResponse {
  return {
    stream: (async function* () {
      yield new vscode.LanguageModelTextPart(text);
    })(),
    text: (async function* () {
      yield text;
    })(),
  } as vscode.LanguageModelChatResponse;
}

function model(
  sendRequest: vscode.LanguageModelChat["sendRequest"],
  id = MODEL_ID,
): vscode.LanguageModelChat {
  return {
    id,
    name: id,
    family: id,
    version: id,
    vendor: "copilot",
    maxInputTokens: 100000,
    capabilities: { supportsImageToText: false, supportsToolCalling: true },
    sendRequest,
    countTokens: async () => 1,
  } as vscode.LanguageModelChat;
}

/** A stale handle that fails like VS Code, and a fresh one that succeeds. */
function staleAndFresh(staleError: () => Error = notRegistered) {
  const calls = { stale: 0, fresh: 0, resolves: 0 };
  const stale = model(async () => {
    calls.stale++;
    throw staleError();
  });
  const fresh = model(async () => {
    calls.fresh++;
    return textResponse("FRESH_OK");
  });
  const resolve = async () => {
    calls.resolves++;
    return { client: calls.resolves === 1 ? stale : fresh };
  };
  return { calls, stale, fresh, resolve };
}

suite("Stale model handle recovery", () => {
  suite("isStaleModelHandleError", () => {
    test("matches only the two upstream stale-handle errors", () => {
      assert.strictEqual(isStaleModelHandleError(notRegistered()), true);
      assert.strictEqual(
        isStaleModelHandleError(vscode.LanguageModelError.NotFound("gone")),
        true,
      );

      for (const error of [
        vscode.LanguageModelError.NoPermissions("denied"),
        vscode.LanguageModelError.Blocked("quota"),
        new Error("Request failed: 429 rate limited"),
        new Error("network error: ECONNRESET"),
        new Error("Chat model copilot/x could not be found."),
        new Error("prefix Chat provider for model x is not registered."),
        "Chat provider for model x is not registered.",
        undefined,
      ]) {
        assert.strictEqual(isStaleModelHandleError(error), false, `${error}`);
      }
    });
  });

  suite("sendWithStaleModelRetry", () => {
    const send = (client: vscode.LanguageModelChat) =>
      client.sendRequest([], {}, new vscode.CancellationTokenSource().token);

    for (const [label, makeError] of [
      ["main-thread not-registered error", notRegistered],
      [
        "extension-host NotFound error",
        () => vscode.LanguageModelError.NotFound(MODEL_ID),
      ],
    ] as const) {
      test(`re-resolves the same model once after a ${label}`, async () => {
        const { calls, stale, fresh, resolve } = staleAndFresh(makeError);
        const { client } = await resolve();
        assert.strictEqual(client, stale);

        const sent = await sendWithStaleModelRetry(client, send, { resolve });

        assert.strictEqual(sent.client, fresh);
        assert.deepStrictEqual(calls, { stale: 1, fresh: 1, resolves: 2 });
      });
    }

    test("retries at most once", async () => {
      let attempts = 0;
      const alwaysStale = () =>
        model(async () => {
          attempts++;
          throw notRegistered();
        });
      const first = alwaysStale();
      await assert.rejects(
        sendWithStaleModelRetry(first, send, {
          resolve: async () => ({ client: alwaysStale() }),
        }),
        /is not registered/,
      );
      assert.strictEqual(attempts, 2);
    });

    test("never switches to a different model", async () => {
      let otherCalls = 0;
      const stale = model(async () => {
        throw notRegistered();
      });
      const other = model(async () => {
        otherCalls++;
        return textResponse("OTHER");
      }, "some-other-model");

      await assert.rejects(
        sendWithStaleModelRetry(stale, send, {
          resolve: async () => ({ client: other }),
        }),
        /is not registered/,
      );
      assert.strictEqual(otherCalls, 0);
    });

    test("does not retry when re-resolution returns the same stale handle", async () => {
      let attempts = 0;
      const stale = model(async () => {
        attempts++;
        throw notRegistered();
      });
      await assert.rejects(
        sendWithStaleModelRetry(stale, send, {
          resolve: async () => ({ client: stale }),
        }),
        /is not registered/,
      );
      assert.strictEqual(attempts, 1);
    });

    test("does not retry other errors", async () => {
      for (const error of [
        vscode.LanguageModelError.NoPermissions("denied"),
        vscode.LanguageModelError.Blocked("quota"),
        new Error("network error"),
      ]) {
        let resolves = 0;
        const failing = model(async () => {
          throw error;
        });
        await assert.rejects(
          sendWithStaleModelRetry(failing, send, {
            resolve: async () => {
              resolves++;
              return { client: failing };
            },
          }),
          (thrown) => thrown === error,
        );
        assert.strictEqual(resolves, 0, `${error.message}`);
      }
    });

    test("does not retry a cancelled request", async () => {
      const source = new vscode.CancellationTokenSource();
      source.cancel();
      let resolves = 0;
      const stale = model(async () => {
        throw notRegistered();
      });
      await assert.rejects(
        sendWithStaleModelRetry(stale, send, {
          cancellationToken: source.token,
          resolve: async () => {
            resolves++;
            return { client: model(async () => textResponse("x")) };
          },
        }),
        /is not registered/,
      );
      assert.strictEqual(resolves, 0);
    });

    test("does not retry when the request is cancelled during re-resolution", async () => {
      const source = new vscode.CancellationTokenSource();
      let freshCalls = 0;
      const stale = model(async () => {
        throw notRegistered();
      });
      const fresh = model(async () => {
        freshCalls++;
        return textResponse("x");
      });
      await assert.rejects(
        sendWithStaleModelRetry(stale, send, {
          cancellationToken: source.token,
          resolve: async () => {
            source.cancel();
            return { client: fresh };
          },
        }),
        /is not registered/,
      );
      assert.strictEqual(freshCalls, 0);
    });

    test("drops cached handles before re-resolving", async () => {
      const originalInvalidate = chatModelsCache.invalidate;
      let invalidations = 0;
      chatModelsCache.invalidate = () => {
        invalidations++;
      };
      try {
        const { stale, resolve } = staleAndFresh();
        await resolve();
        await sendWithStaleModelRetry(stale, send, { resolve });
        assert.strictEqual(invalidations, 1);
      } finally {
        chatModelsCache.invalidate = originalInvalidate;
      }
    });
  });

  suite("routes recover from a stale handle", () => {
    const routes: {
      name: string;
      register: (
        app: OpenAPIHono,
        resolve: ReturnType<typeof staleAndFresh>["resolve"],
      ) => void;
      path: string;
      body: Record<string, unknown>;
    }[] = [
      {
        name: "Anthropic messages",
        register: (app, resolve) =>
          registerAnthropicRoutes(app, { resolveChatModelClient: resolve }),
        path: "/v1/messages",
        body: {
          model: MODEL_ID,
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
        },
      },
      {
        name: "OpenAI chat completions",
        register: (app, resolve) =>
          registerOpenaiChatRoutes(app, { resolveChatModelClient: resolve }),
        path: "/v1/chat/completions",
        body: { model: MODEL_ID, messages: [{ role: "user", content: "hi" }] },
      },
      {
        name: "OpenAI Responses",
        register: (app, resolve) =>
          registerOpenaiResponsesRoutes(app, {
            resolveChatModelClient: resolve,
          }),
        path: "/v1/responses",
        body: { model: MODEL_ID, input: "hi" },
      },
      {
        name: "Gemini generateContent",
        register: (app, resolve) =>
          registerGeminiRoutes(app, { resolveChatModelClient: resolve }),
        path: `/v1beta/models/${MODEL_ID}:generateContent`,
        body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
      },
    ];

    for (const route of routes) {
      test(route.name, async () => {
        const { calls, resolve } = staleAndFresh();
        const app = new OpenAPIHono();
        route.register(app, resolve);

        const response = await app.request(route.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(route.body),
        });

        const text = await response.text();
        assert.strictEqual(response.status, 200, text);
        assert.match(text, /FRESH_OK/);
        assert.deepStrictEqual(calls, { stale: 1, fresh: 1, resolves: 2 });
      });
    }
  });

  suite("ChatModelsCache", () => {
    test("invalidate makes the next lookup re-query VS Code", async () => {
      const originalSelect = vscode.lm.selectChatModels;
      let queries = 0;
      vscode.lm.selectChatModels = async () => {
        queries++;
        return [model(async () => textResponse("x"))];
      };
      try {
        await chatModelsCache.refresh();
        await chatModelsCache.getChatModels();
        assert.strictEqual(queries, 1, "cached handles are reused");

        chatModelsCache.invalidate();
        await chatModelsCache.getChatModels();
        assert.strictEqual(queries, 2, "invalidated handles are re-queried");
      } finally {
        vscode.lm.selectChatModels = originalSelect;
        await chatModelsCache.refresh();
      }
    });
  });
});
