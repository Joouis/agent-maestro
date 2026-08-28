import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as vscode from "vscode";

import { ExtensionController } from "../../core/controller";
import { registerRooRoutes } from "../../server/routes/rooRoutes";

suite("Roo Profile Routes Test Suite", () => {
  test("redacts MiniMax API keys from profile details", async () => {
    const adapter = {
      isActive: true,
      getProfileEntry: () => ({
        id: "profile-1",
        apiProvider: "minimax",
      }),
      getActiveProfile: () => "MiniMax",
      api: {
        getConfiguration: () => ({
          minimaxApiKey: "minimax-secret",
          modelTemperature: 0.5,
        }),
      },
    };
    const controller = {
      getRooAdapter: () => adapter,
    } as unknown as ExtensionController;
    const app = new OpenAPIHono();

    registerRooRoutes(app, controller, {} as vscode.ExtensionContext);

    const response = await app.request("/roo/profiles/MiniMax");
    const body = (await response.json()) as {
      profile: Record<string, unknown>;
    };

    assert.strictEqual(response.status, 200);
    assert.strictEqual("minimaxApiKey" in body.profile, false);
    assert.strictEqual(body.profile.apiProvider, "minimax");
    assert.strictEqual(body.profile.modelTemperature, 0.5);
  });
});
