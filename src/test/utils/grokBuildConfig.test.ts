import * as assert from "assert";
import * as os from "os";
import * as path from "path";

import {
  GROK_BUILD_MODEL_KEY,
  GROK_BUILD_PLACEHOLDER_API_KEY,
  buildGrokBuildConfig,
  getGrokBuildConfigPath,
} from "../../utils/grokBuildConfig";

suite("Grok Build Config", () => {
  test("uses GROK_HOME when it is set", () => {
    const configPath = getGrokBuildConfigPath(
      { GROK_HOME: "/tmp/custom-grok" },
      "/home/user",
    );

    assert.strictEqual(
      configPath,
      path.join("/tmp/custom-grok", "config.toml"),
    );
  });

  test("falls back to the home .grok directory", () => {
    const configPath = getGrokBuildConfigPath({}, "/home/user");

    assert.strictEqual(
      configPath,
      path.join("/home/user", ".grok", "config.toml"),
    );
  });

  test("treats a blank GROK_HOME as unset", () => {
    const configPath = getGrokBuildConfigPath(
      { GROK_HOME: "   " },
      os.homedir(),
    );

    assert.strictEqual(
      configPath,
      path.join(os.homedir(), ".grok", "config.toml"),
    );
  });

  test("creates the agent-maestro model with the placeholder key", () => {
    const config = buildGrokBuildConfig({
      existingConfig: {},
      modelId: "gpt-5.5",
      baseUrl: "http://127.0.0.1:23333/api/openai/v1",
      contextWindow: 272000,
    });

    assert.strictEqual(config.models?.default, GROK_BUILD_MODEL_KEY);
    assert.deepStrictEqual(config.model?.[GROK_BUILD_MODEL_KEY], {
      model: "gpt-5.5",
      base_url: "http://127.0.0.1:23333/api/openai/v1",
      name: "Agent Maestro",
      api_key: GROK_BUILD_PLACEHOLDER_API_KEY,
      context_window: 272000,
    });
  });

  test("writes the configured LLM API key", () => {
    const config = buildGrokBuildConfig({
      existingConfig: {
        model: {
          [GROK_BUILD_MODEL_KEY]: {
            api_key: "old-custom-key",
          },
        },
      },
      modelId: "gpt-5.5",
      baseUrl: "http://127.0.0.1:24444/api/openai/v1",
      configuredApiKey: "llm-key",
    });

    assert.strictEqual(
      config.model?.[GROK_BUILD_MODEL_KEY]?.api_key,
      "llm-key",
    );
  });

  test("keeps an existing model key when no LLM API key is configured", () => {
    const config = buildGrokBuildConfig({
      existingConfig: {
        model: {
          [GROK_BUILD_MODEL_KEY]: {
            api_key: "kept-key",
            temperature: 0.2,
          },
        },
      },
      modelId: "gpt-5.5",
      baseUrl: "http://127.0.0.1:23333/api/openai/v1",
    });

    assert.strictEqual(
      config.model?.[GROK_BUILD_MODEL_KEY]?.api_key,
      "kept-key",
    );
    assert.strictEqual(config.model?.[GROK_BUILD_MODEL_KEY]?.temperature, 0.2);
  });

  test("drops a stale context window when the selected model has none", () => {
    const config = buildGrokBuildConfig({
      existingConfig: {
        model: {
          [GROK_BUILD_MODEL_KEY]: {
            context_window: 272000,
          },
        },
      },
      modelId: "gpt-5.5",
      baseUrl: "http://127.0.0.1:23333/api/openai/v1",
    });

    assert.strictEqual(
      Object.hasOwn(
        config.model?.[GROK_BUILD_MODEL_KEY] ?? {},
        "context_window",
      ),
      false,
    );
  });

  test("preserves unrelated config and omits an unknown context window", () => {
    const config = buildGrokBuildConfig({
      existingConfig: {
        models: {
          web_search: "grok-4.5",
          extra_headers: { "X-Request-Tags": "team=example" },
        },
        model: {
          "company-grok": {
            model: "grok-4.6",
          },
        },
        mcp_servers: {
          github: { command: "npx" },
        },
      },
      modelId: "claude-sonnet-4",
      baseUrl: "http://127.0.0.1:23333/api/openai/v1",
    });

    assert.strictEqual(config.models?.web_search, "grok-4.5");
    assert.deepStrictEqual(config.models?.extra_headers, {
      "X-Request-Tags": "team=example",
    });
    assert.deepStrictEqual(config.model?.["company-grok"], {
      model: "grok-4.6",
    });
    assert.deepStrictEqual(config.mcp_servers, {
      github: { command: "npx" },
    });
    assert.strictEqual(
      config.model?.[GROK_BUILD_MODEL_KEY]?.context_window,
      undefined,
    );
  });
});
