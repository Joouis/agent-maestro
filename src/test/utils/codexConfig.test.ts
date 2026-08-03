import * as assert from "assert";

import { buildCodexConfig } from "../../commands/configuratorCommands";

suite("Codex Configuration Test Suite", () => {
  test("enables standalone search for GPT-5+ models", () => {
    const config = buildCodexConfig(
      { features: { existing_feature: true } },
      "gpt-5.6-sol",
      100000,
      23333,
    );

    assert.strictEqual(config.features?.existing_feature, true);
    assert.strictEqual(config.features?.standalone_web_search, true);
    assert.strictEqual(
      config.model_providers["agent-maestro"].supports_standalone_web_search,
      true,
    );
  });

  test("does not advertise standalone search for earlier models", () => {
    const config = buildCodexConfig({}, "gpt-4.1", 100000, 23333);

    assert.strictEqual(config.features, undefined);
    assert.strictEqual(
      config.model_providers["agent-maestro"].supports_standalone_web_search,
      undefined,
    );
  });
});
