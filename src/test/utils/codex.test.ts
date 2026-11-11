import * as assert from "assert";
import fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createCodexConfiguration,
  resolveCodexCatalogPath,
  writeCodexConfiguration,
} from "../../utils/codex";

suite("Codex Configuration Test Suite", () => {
  const selected = { modelId: "grok-test", maxInputTokens: 400000 };
  const createCatalog = () => ({
    metadata: { version: "client-version" },
    models: [
      {
        slug: "gpt-test",
        context_window: 200000,
        max_context_window: 200000,
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
        base_instructions: "Preserve the client's instructions.",
      },
      {
        slug: "grok-test",
        context_window: 100000,
        max_context_window: 100000,
        default_reasoning_level: "low",
        supported_reasoning_levels: [{ effort: "low" }],
        use_responses_lite: false,
        unknown_field: { keep: true },
      },
      { slug: "custom-model", instructions: "Keep user metadata." },
    ],
  });

  test("keeps single-model setup and unrelated provider settings", () => {
    const config = {
      model_reasoning_effort: "high",
      web_search: "disabled",
      features: { custom: true },
      model_providers: {
        other: { name: "Other" },
        "agent-maestro": { env_key: "EXISTING_KEY" },
      },
    };
    const result = createCodexConfiguration(config, selected, 23456);
    assert.strictEqual(result.catalog, undefined);
    assert.strictEqual(result.config.model_context_window, 400000);
    assert.strictEqual(result.config.model_reasoning_effort, "high");
    assert.strictEqual(result.config.web_search, "disabled");
    assert.deepStrictEqual(result.config.features, {
      custom: true,
      standalone_web_search: true,
    });
    assert.deepStrictEqual(result.config.model_providers, {
      other: { name: "Other" },
      "agent-maestro": {
        env_key: "EXISTING_KEY",
        name: "Agent Maestro",
        base_url: "http://127.0.0.1:23456/api/openai/v1",
        wire_api: "responses",
        supports_standalone_web_search: true,
      },
    });
  });

  test("moves GPT globals into its entry before selecting another model", () => {
    const catalog = createCatalog();
    const original = JSON.parse(JSON.stringify(catalog));
    const config = {
      model: "gpt-test",
      model_catalog_json: "models.json",
      model_context_window: 800000,
      model_reasoning_effort: "high",
    };
    const result = createCodexConfiguration(config, selected, 23333, catalog);
    const models = result.catalog!.models as Record<string, unknown>[];
    assert.strictEqual(result.config.model, "grok-test");
    assert.strictEqual(result.config.model_context_window, undefined);
    assert.strictEqual(result.config.model_reasoning_effort, undefined);
    assert.strictEqual(models[0].context_window, 800000);
    assert.strictEqual(models[0].max_context_window, 800000);
    assert.strictEqual(models[0].default_reasoning_level, "high");
    assert.strictEqual(models[1].context_window, 400000);
    assert.strictEqual(models[1].max_context_window, 400000);
    assert.strictEqual(models[1].default_reasoning_level, "low");
    assert.deepStrictEqual(models[1].unknown_field, { keep: true });
    assert.strictEqual(models[1].use_responses_lite, false);
    assert.deepStrictEqual(models[2], catalog.models[2]);
    assert.deepStrictEqual(result.catalog!.metadata, catalog.metadata);
    assert.deepStrictEqual(catalog, original);
    assert.strictEqual(config.model_reasoning_effort, "high");
  });

  test("uses refreshed context for the same selected model without losing effort", () => {
    const result = createCodexConfiguration(
      {
        model: "gpt-test",
        model_catalog_json: "models.json",
        model_context_window: 250000,
        model_reasoning_effort: "high",
      },
      { modelId: "gpt-test", maxInputTokens: 300000 },
      23333,
      createCatalog(),
    );
    const model = (result.catalog!.models as Record<string, unknown>[])[0];
    assert.strictEqual(model.context_window, 300000);
    assert.strictEqual(model.max_context_window, 300000);
    assert.strictEqual(model.default_reasoning_level, "high");
  });

  test("does not need a previous model when there are no global overrides", () => {
    const catalog = createCatalog();
    const result = createCodexConfiguration(
      { model: "unavailable", model_catalog_json: "models.json" },
      selected,
      23333,
      catalog,
    );
    const models = result.catalog!.models as Record<string, unknown>[];
    assert.deepStrictEqual(models[0], catalog.models[0]);
    assert.deepStrictEqual(models[2], catalog.models[2]);
  });

  test("rejects missing models, invalid catalogs, and ambiguous migrations", () => {
    const config = { model: "gpt-test", model_catalog_json: "models.json" };
    assert.throws(
      () => createCodexConfiguration(config, selected, 23333),
      /models array/,
    );
    assert.throws(
      () => createCodexConfiguration(config, selected, 23333, { models: [] }),
      /Add 'grok-test'/,
    );
    assert.throws(
      () =>
        createCodexConfiguration(config, selected, 23333, {
          models: [{ slug: "same" }, { slug: "same" }],
        }),
      /Duplicate/,
    );
    assert.throws(
      () =>
        createCodexConfiguration(config, selected, 23333, { models: [null] }),
      /nonempty slug/,
    );
    assert.throws(
      () =>
        createCodexConfiguration(
          { ...config, model: "missing", model_context_window: 100 },
          selected,
          23333,
          createCatalog(),
        ),
      /previous default model is missing/,
    );
    assert.throws(
      () =>
        createCodexConfiguration(
          { ...config, model_reasoning_effort: "ultra" },
          selected,
          23333,
          createCatalog(),
        ),
      /not declared/,
    );
    for (const size of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(
        () =>
          createCodexConfiguration(
            config,
            { ...selected, maxInputTokens: size },
            23333,
            createCatalog(),
          ),
        /positive safe integers/,
      );
    }
  });

  test("resolves paths beside config and rejects ambiguous targets", () => {
    const config = path.resolve("fixture/.codex/config.toml");
    assert.strictEqual(
      resolveCodexCatalogPath(config, "models/catalog.json"),
      path.join(path.dirname(config), "models/catalog.json"),
    );
    const absolute = path.resolve("fixture/models.json");
    assert.strictEqual(resolveCodexCatalogPath(config, absolute), absolute);
    for (const value of [
      "",
      null,
      "~/models.json",
      "https://example.com/models.json",
      config,
    ]) {
      assert.throws(() => resolveCodexCatalogPath(config, value));
    }
  });

  test("backs up both originals before updating configuration and catalog", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "am-codex-"));
    try {
      const config = path.join(directory, "config.toml");
      const catalog = path.join(directory, "models.json");
      fs.writeFileSync(config, "original config");
      fs.writeFileSync(catalog, "original catalog");
      writeCodexConfiguration(config, "updated config", {
        path: catalog,
        content: "updated catalog",
      });
      assert.strictEqual(fs.readFileSync(config, "utf8"), "updated config");
      assert.strictEqual(fs.readFileSync(catalog, "utf8"), "updated catalog");
      const backups = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith(".bak"));
      assert.strictEqual(backups.length, 2);
      const contents = backups.map((name) =>
        fs.readFileSync(path.join(directory, name), "utf8"),
      );
      assert.deepStrictEqual(contents.sort(), [
        "original catalog",
        "original config",
      ]);
      if (process.platform !== "win32") {
        for (const backup of backups) {
          const original = backup.startsWith("config.toml") ? config : catalog;
          assert.strictEqual(
            fs.statSync(path.join(directory, backup)).mode & 0o777,
            fs.statSync(original).mode & 0o777,
          );
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a hard link to the configuration as a catalog target", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "am-codex-"));
    try {
      const config = path.join(directory, "config.toml");
      const alias = path.join(directory, "models.json");
      fs.writeFileSync(config, "original config");
      fs.linkSync(config, alias);
      assert.throws(
        () => resolveCodexCatalogPath(config, alias),
        /different files/,
      );
      if (process.platform === "win32") {
        assert.throws(
          () => resolveCodexCatalogPath(config, config.toUpperCase()),
          /different files/,
        );
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restores the catalog when writing config fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "am-codex-"));
    const config = path.join(directory, "config.toml");
    const catalog = path.join(directory, "models.json");
    const originalWrite = fs.writeFileSync;
    try {
      fs.writeFileSync(config, "original config");
      fs.writeFileSync(catalog, "original catalog");
      let failed = false;
      fs.writeFileSync = ((file, ...args) => {
        if (file === config && !failed) {
          failed = true;
          throw new Error("simulated write failure");
        }
        return originalWrite(file, ...args);
      }) as typeof fs.writeFileSync;
      assert.throws(
        () =>
          writeCodexConfiguration(config, "new config", {
            path: catalog,
            content: "new catalog",
          }),
        /simulated write failure/,
      );
      assert.strictEqual(fs.readFileSync(config, "utf8"), "original config");
      assert.strictEqual(fs.readFileSync(catalog, "utf8"), "original catalog");
    } finally {
      fs.writeFileSync = originalWrite;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
