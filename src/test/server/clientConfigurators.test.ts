import Anthropic from "@anthropic-ai/sdk";
import { OpenAPIHono } from "@hono/zod-openapi";
import * as assert from "assert";
import * as fs from "fs";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import os from "os";
import { join } from "path";
import { parse } from "smol-toml";
import * as vscode from "vscode";

import {
  getClientApiKey,
  quoteGeminiApiKey,
} from "../../commands/clientAuthentication";
import { registerConfiguratorCommands } from "../../commands/configuratorCommands";
import { ProxyServer } from "../../server/ProxyServer";
import { FileHttpAuthentication } from "../../server/httpAuthentication";
import { createApiAuthMiddleware } from "../../server/middleware/authMiddleware";
import { chatModelsCache } from "../../utils/chatModels";
import { getClaudeDesktopConfigDirectory } from "../../utils/claudeDesktop";

suite("Authenticated client configurators", () => {
  let directory: string;
  let authentication: FileHttpAuthentication;
  let handlers: Map<string, () => Promise<void>>;
  let errors: string[];
  let input: string | undefined;
  let project: boolean;
  let restore: () => void;
  const key = "verified-client-key";
  const commands = [
    "configureClaudeCode",
    "configureClaudeDesktop",
    "configureCodex",
    "configureGeminiCli",
  ];

  setup(async () => {
    directory = await mkdtemp(join(os.tmpdir(), "am-client-config-test-"));
    authentication = new FileHttpAuthentication(join(directory, "policy.json"));
    await authentication.configure(key);
    handlers = new Map();
    errors = [];
    input = key;
    project = false;
    const original = {
      home: os.homedir,
      appData: process.env.LOCALAPPDATA,
      register: vscode.commands.registerCommand,
      pick: vscode.window.showQuickPick,
      input: vscode.window.showInputBox,
      info: vscode.window.showInformationMessage,
      error: vscode.window.showErrorMessage,
      models: chatModelsCache.getChatModels,
      folders: Object.getOwnPropertyDescriptor(
        vscode.workspace,
        "workspaceFolders",
      ),
    };
    os.homedir = () => directory;
    process.env.LOCALAPPDATA = join(directory, "AppData", "Local");
    const window = vscode.window as any;
    (vscode.commands as any).registerCommand = (
      id: string,
      handler: () => Promise<void>,
    ) => {
      handlers.set(id, handler);
      return { dispose: () => {} };
    };
    window.showQuickPick = async (choices: any[], options: any) => {
      if (options?.title === "Reload Window") {
        return "No";
      }
      return (
        choices.find(
          (c) => c.label === (project ? "Project Settings" : "User Settings"),
        ) ??
        choices.find((c) => c.modelId) ??
        "Yes"
      );
    };
    window.showInputBox = async () => input;
    window.showInformationMessage = async () => undefined;
    window.showErrorMessage = async (message: string) => {
      errors.push(message);
    };
    chatModelsCache.getChatModels = async () =>
      [
        {
          id: "test-model",
          family: "gpt",
          vendor: "copilot",
          name: "Test Model",
          maxInputTokens: 100000,
        },
      ] as vscode.LanguageModelChat[];
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      configurable: true,
      value: [{ uri: vscode.Uri.file(directory), name: "test", index: 0 }],
    });
    restore = () => {
      os.homedir = original.home;
      if (original.appData === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = original.appData;
      }
      (vscode.commands as any).registerCommand = original.register;
      window.showQuickPick = original.pick;
      window.showInputBox = original.input;
      window.showInformationMessage = original.info;
      window.showErrorMessage = original.error;
      chatModelsCache.getChatModels = original.models;
      if (original.folders) {
        Object.defineProperty(
          vscode.workspace,
          "workspaceFolders",
          original.folders,
        );
      }
    };
    registerConfiguratorCommands(
      {
        authentication,
        getStatus: () => ({ port: 23333 }),
      } as unknown as ProxyServer,
      { subscriptions: [] } as unknown as vscode.ExtensionContext,
    );
  });
  teardown(async () => {
    restore();
    await rm(directory, { recursive: true, force: true });
  });

  async function run(name: string): Promise<void> {
    await handlers.get("agent-maestro." + name)!();
  }
  async function json(filePath: string): Promise<any> {
    return JSON.parse(await readFile(filePath, "utf8"));
  }
  async function privateFile(filePath: string): Promise<void> {
    if (process.platform !== "win32") {
      assert.strictEqual((await stat(filePath)).mode & 0o777, 0o600);
    }
  }

  test("all four generated credentials pass the configured API boundary", async () => {
    for (const command of commands) {
      await run(command);
    }
    assert.deepStrictEqual(errors, []);
    const claudePath = join(directory, ".claude", "settings.json");
    const claude = await json(claudePath);
    assert.strictEqual(claude.env.ANTHROPIC_API_KEY, key);
    assert.strictEqual(claude.env.ANTHROPIC_AUTH_TOKEN, "");
    const codexPath = join(directory, ".codex", "config.toml");
    const codex = parse(await readFile(codexPath, "utf8")) as any;
    const provider = codex.model_providers["agent-maestro"];
    assert.strictEqual(provider.requires_openai_auth, false);
    const desktopDirectory = getClaudeDesktopConfigDirectory();
    const metadata = await json(join(desktopDirectory, "_meta.json"));
    const desktopPath = join(desktopDirectory, metadata.appliedId + ".json");
    const desktop = await json(desktopPath);
    assert.strictEqual(desktop.inferenceGatewayAuthScheme, "x-api-key");
    const geminiPath = join(directory, ".gemini", ".env");
    const env = await readFile(geminiPath, "utf8");
    assert.ok(env.includes(`GEMINI_API_KEY='${key}'`));
    assert.strictEqual(
      (await json(join(directory, ".gemini", "settings.json"))).security.auth
        .selectedType,
      "gemini-api-key",
    );
    for (const [protocol, headers] of [
      ["anthropic", { "x-api-key": claude.env.ANTHROPIC_API_KEY }],
      ["anthropic", { "x-api-key": desktop.inferenceGatewayApiKey }],
      ["openai", provider.http_headers],
      ["gemini", { "x-goog-api-key": key }],
    ] as const) {
      const app = new OpenAPIHono();
      app.use("*", createApiAuthMiddleware(authentication, protocol));
      app.get("/", (c) => c.json({ ok: true }));
      assert.strictEqual((await app.request("/", { headers })).status, 200);
    }
    for (const filePath of [claudePath, codexPath, desktopPath, geminiPath]) {
      await privateFile(filePath);
    }
  });

  test("reruns replace stale credentials and preserve unrelated settings", async () => {
    fs.mkdirSync(join(directory, ".codex"));
    fs.writeFileSync(
      join(directory, ".codex", "config.toml"),
      `[model_providers.agent-maestro]
name = "Existing"
env_key = "OLD_KEY"
requires_openai_auth = true
experimental_bearer_token = "stale"
[model_providers.agent-maestro.auth]
command = "old-helper"
[model_providers.agent-maestro.http_headers]
authorization = "Bearer stale"
X-Custom = "preserve"
[model_providers.agent-maestro.env_http_headers]
AUTHORIZATION = "STALE_HEADER"
X-Environment = "CUSTOM_ENV"
[model_providers.other]
name = "Other Provider"
`,
    );
    fs.mkdirSync(join(directory, ".gemini"));
    fs.writeFileSync(
      join(directory, ".gemini", ".env"),
      "GEMINI_API_KEY=stale" + String.fromCharCode(10) + "OTHER=keep",
    );
    fs.mkdirSync(join(directory, ".claude"));
    fs.writeFileSync(
      join(directory, ".claude", "settings.json"),
      JSON.stringify({
        apiKeyHelper: "old-helper",
        env: {
          ANTHROPIC_AUTH_TOKEN: "stale",
          ANTHROPIC_API_KEY: "stale",
          OTHER: "keep",
        },
      }),
    );
    await run("configureCodex");
    await run("configureGeminiCli");
    await run("configureClaudeCode");
    assert.deepStrictEqual(errors, []);
    const codex = parse(
      await readFile(join(directory, ".codex", "config.toml"), "utf8"),
    ) as any;
    const provider = codex.model_providers["agent-maestro"];
    for (const property of ["auth", "env_key", "experimental_bearer_token"]) {
      assert.strictEqual(provider[property], undefined);
    }
    assert.deepStrictEqual(provider.http_headers, {
      "X-Custom": "preserve",
      Authorization: `Bearer ${key}`,
    });
    assert.deepStrictEqual(provider.env_http_headers, {
      "X-Environment": "CUSTOM_ENV",
    });
    assert.strictEqual(codex.model_providers.other.name, "Other Provider");
    const claude = await json(join(directory, ".claude", "settings.json"));
    assert.strictEqual(claude.apiKeyHelper, undefined);
    assert.strictEqual(claude.env.OTHER, "keep");
    assert.ok(
      (await readFile(join(directory, ".gemini", ".env"), "utf8")).includes(
        `GEMINI_API_KEY='${key}'`,
      ),
    );
  });

  for (const scenario of ["canceled", "wrong-key", "unconfigured"] as const) {
    test(`${scenario} aborts every configurator before writing client files`, async () => {
      if (scenario === "canceled") {
        input = undefined;
      }
      if (scenario === "wrong-key") {
        input = "wrong-key";
      }
      if (scenario === "unconfigured") {
        await rm(join(directory, "policy.json"));
      }
      for (const command of commands) {
        await run(command);
      }
      assert.strictEqual(fs.existsSync(join(directory, ".claude")), false);
      assert.strictEqual(fs.existsSync(join(directory, ".codex")), false);
      assert.strictEqual(fs.existsSync(join(directory, ".gemini")), false);
      assert.strictEqual(
        fs.existsSync(getClaudeDesktopConfigDirectory()),
        false,
      );
      assert.strictEqual(errors.length, scenario === "canceled" ? 0 : 4);
    });
  }

  test("project-local credentials override a stale shared Claude bearer token", async () => {
    project = true;
    const sharedPath = join(directory, ".claude", "settings.json");
    const shared = {
      env: {
        ANTHROPIC_AUTH_TOKEN: "stale-shared-token",
        ANTHROPIC_API_KEY: "stale-key",
        TEAM_SETTING: "preserve",
      },
    };
    fs.mkdirSync(join(directory, ".claude"));
    fs.writeFileSync(sharedPath, JSON.stringify(shared));
    await run("configureClaudeCode");
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(await json(sharedPath), shared);
    const local = await json(join(directory, ".claude", "settings.local.json"));
    // Claude's documented priority is project-local > shared project > user.
    const mergedEnv = { ...shared.env, ...local.env };
    assert.strictEqual(mergedEnv.ANTHROPIC_AUTH_TOKEN, "");
    assert.strictEqual(mergedEnv.ANTHROPIC_API_KEY, key);
    assert.strictEqual(mergedEnv.TEAM_SETTING, "preserve");
    const app = new OpenAPIHono();
    app.use("*", createApiAuthMiddleware(authentication, "anthropic"));
    app.post("/v1/messages", (c) =>
      c.json({
        id: "test",
        type: "message",
        role: "assistant",
        model: "test",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );
    let requests = 0;
    const client = new Anthropic({
      apiKey: mergedEnv.ANTHROPIC_API_KEY,
      authToken: mergedEnv.ANTHROPIC_AUTH_TOKEN,
      baseURL: "http://local.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        assert.strictEqual(request.headers.get("x-api-key"), key);
        const response = await app.fetch(request);
        assert.strictEqual(response.status, 200);
        requests++;
        return response;
      },
    });
    await client.messages.create({
      model: "test",
      max_tokens: 1,
      messages: [{ role: "user", content: "test" }],
    });
    assert.strictEqual(requests, 1);
  });

  test("project Claude credentials use settings.local.json", async () => {
    project = true;
    await run("configureClaudeCode");
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(
      (await json(join(directory, ".claude", "settings.local.json"))).env
        .ANTHROPIC_API_KEY,
      key,
    );
    assert.strictEqual(
      fs.existsSync(join(directory, ".claude", "settings.json")),
      false,
    );
  });

  test("explicitly disabled authentication does not prompt for a real key", async () => {
    await authentication.configure(null);
    input = undefined;
    for (const command of commands) {
      await run(command);
    }
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(
      (await json(join(directory, ".claude", "settings.json"))).env
        .ANTHROPIC_API_KEY,
      "Powered by Agent Maestro",
    );
  });

  test("Gemini quoting retains literal characters or fails instead of corrupting the key", () => {
    assert.strictEqual(quoteGeminiApiKey("a#b$c=d\\n"), "'a#b$c=d\\n'");
    assert.strictEqual(quoteGeminiApiKey("a'b"), "`a'b`");
    assert.throws(() => quoteGeminiApiKey("a'`\"b"), /losslessly/);
  });

  test("credential validation is repeated after the input is submitted", async () => {
    let calls = 0;
    const result = await getClientApiKey(
      {
        getStatus: async () => "enabled",
        configure: async () => {},
        authorize: async () => {
          calls++;
          return "denied";
        },
      },
      "Test",
      "test.json",
    ).catch((error) => error);
    assert.match(result.message, /does not match/);
    assert.strictEqual(calls, 1);
  });
});
