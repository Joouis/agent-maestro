import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET,
  READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET,
  getCopilotBundlePath,
  getCopilotBundlePermissionMessage,
  getRunningCopilotBundlePath,
  listCopilotWebSearchBackups,
  patchCopilotWebSearchBundle,
  restoreCopilotWebSearchBackup,
} from "../../utils/copilotWebSearchPatch";

suite("CopilotWebSearchPatch Test Suite", () => {
  const testDir = path.join(os.tmpdir(), "copilot-web-search-patch-tests");
  const bundlePath = path.join(testDir, "extension.js");
  const toolSearchSnippet =
    'let y=[...h];g&&y.unshift({type:"tool_search",execution:"client",description:"Search for relevant tools by describing what you need. Returns tool definitions for tools matching your query.",parameters:{type:"object",properties:{query:{type:"string",description:"Natural language description of what tool capability you are looking for."}},required:["query"]}});';
  const toolMapSnippet =
    "let v=e.requestOptions?.tools?new Map(e.requestOptions.tools.map(B=>[B.function.name,B])):void 0";

  setup(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  teardown(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test("should resolve the Copilot bundle path from app root", () => {
    assert.strictEqual(
      getCopilotBundlePath(
        "/Applications/Visual Studio Code.app/Contents/Resources/app",
      ),
      "/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/dist/extension.js",
    );
  });

  test("should resolve a loaded Copilot extension bundle path", () => {
    const extensionDir = path.join(testDir, "copilot-chat");
    const extensionBundlePath = path.join(extensionDir, "dist", "extension.js");
    fs.mkdirSync(path.dirname(extensionBundlePath), { recursive: true });
    fs.writeFileSync(extensionBundlePath, "bundle");

    assert.strictEqual(
      getRunningCopilotBundlePath({
        appRoot: "/Applications/Visual Studio Code.app/Contents/Resources/app",
        extensionPath: extensionDir,
        extensionMain: "./dist/extension",
      }),
      extensionBundlePath,
    );
  });

  test("should reject empty app root", () => {
    assert.throws(() => getCopilotBundlePath(""), /app root is unavailable/);
  });

  test("should patch bundle and create a backup", () => {
    fs.writeFileSync(
      bundlePath,
      `prefix ${toolSearchSnippet}${toolMapSnippet} suffix`,
    );

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "patched");
    assert.ok(result.backupPath, "backup path should be returned");
    assert.ok(fs.existsSync(result.backupPath));

    const patchedContent = fs.readFileSync(bundlePath, "utf8");
    assert.ok(patchedContent.includes(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET));
    assert.strictEqual(
      patchedContent.indexOf(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET),
      patchedContent.lastIndexOf(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET),
    );

    const backupContent = fs.readFileSync(result.backupPath, "utf8");
    assert.ok(!backupContent.includes(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET));
  });

  test("should not patch an already patched bundle again", () => {
    fs.writeFileSync(
      bundlePath,
      `${toolSearchSnippet}${GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET}${toolMapSnippet}`,
    );

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "already-patched");
    assert.strictEqual(result.backupPath, undefined);
  });

  test("should reject multiple minified injection points", () => {
    const injectionPoint = `${toolSearchSnippet}${toolMapSnippet}`;
    fs.writeFileSync(bundlePath, `${injectionPoint}${injectionPoint}`);

    assert.throws(
      () => patchCopilotWebSearchBundle(bundlePath),
      /Expected to find a supported Copilot Responses tool injection point/,
    );
  });

  test("should migrate a legacy unconditional patch", () => {
    const legacyPatchSnippet =
      '((B=>{let Q=/^gpt-(\\d+)/.exec(String(B).toLowerCase().replace(/\\./g,"-"));return!!Q&&Number(Q[1])>=5})(t)||(B=>{let Q=/^gpt-(\\d+)/.exec(String(B).toLowerCase().replace(/\\./g,"-"));return!!Q&&Number(Q[1])>=5})(r.family))&&!y.some(B=>typeof B?.type=="string"&&B.type.startsWith("web_search"))&&y.unshift({type:"web_search_preview"});';
    fs.writeFileSync(
      bundlePath,
      `${toolSearchSnippet}${legacyPatchSnippet}${toolMapSnippet}`,
    );

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "patched");
    assert.ok(result.backupPath);

    const patchedContent = fs.readFileSync(bundlePath, "utf8");
    assert.ok(patchedContent.includes(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET));
    assert.ok(!patchedContent.includes(legacyPatchSnippet));
  });

  test("should migrate legacy patches with different local variable names", () => {
    const legacyPatchSnippet =
      '((X=>{let Y=/^gpt-(\\d+)/.exec(String(X).toLowerCase().replace(/\\./g,"-"));return!!Y&&Number(Y[1])>=5})(t)||(X=>{let Y=/^gpt-(\\d+)/.exec(String(X).toLowerCase().replace(/\\./g,"-"));return!!Y&&Number(Y[1])>=5})(r.family))&&!y.some(X=>typeof X?.type=="string"&&X.type.startsWith("web_search"))&&y.unshift({type:"web_search_preview"});';
    fs.writeFileSync(
      bundlePath,
      `${toolSearchSnippet}${legacyPatchSnippet}${toolMapSnippet}`,
    );

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "patched");
    const patchedContent = fs.readFileSync(bundlePath, "utf8");
    assert.ok(patchedContent.includes(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET));
    assert.ok(!patchedContent.includes(legacyPatchSnippet));
  });

  test("should migrate marker patches that read nested modelOptions only", () => {
    const legacyPatchSnippet =
      '(()=>{let B=e.requestOptions?.modelOptions,Q=B?.agentMaestroWebSearchTool;if(Q&&typeof Q.type=="string"&&Q.type.startsWith("web_search")){delete B.agentMaestroWebSearchTool;((X=>{let ee=/^gpt-(\\d+)/.exec(String(X).toLowerCase().replace(/\\./g,"-"));return!!ee&&Number(ee[1])>=5})(t)||(X=>{let ee=/^gpt-(\\d+)/.exec(String(X).toLowerCase().replace(/\\./g,"-"));return!!ee&&Number(ee[1])>=5})(r.family))&&!y.some(X=>typeof X?.type=="string"&&X.type.startsWith("web_search"))&&y.unshift(Q)}})();';
    fs.writeFileSync(
      bundlePath,
      `${toolSearchSnippet}${legacyPatchSnippet}${toolMapSnippet}`,
    );

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "patched");
    const patchedContent = fs.readFileSync(bundlePath, "utf8");
    assert.ok(patchedContent.includes(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET));
    assert.ok(!patchedContent.includes(legacyPatchSnippet));
  });

  test("should patch readable Copilot Chat development bundles", () => {
    const readableSnippet = `function createResponsesRequestBody(accessor, options, model, endpoint) {
  const body3 = {
    model,
    tools: options.requestOptions?.tools?.map((tool) => ({
      ...tool.function,
      type: "function",
      strict: false,
      parameters: tool.function.parameters || {}
    })),
    text: verbosity ? { verbosity } : void 0
  };
  const contextManagementEnabled = true;
  return body3;
}`;
    fs.writeFileSync(bundlePath, readableSnippet);

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "patched");
    const patchedContent = fs.readFileSync(bundlePath, "utf8");
    assert.ok(
      patchedContent.includes(READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET),
    );
    assert.strictEqual(
      patchedContent.indexOf(READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET),
      patchedContent.lastIndexOf(READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET),
    );
  });

  test("should reject multiple readable injection points", () => {
    const injectionPoint = `    text: verbosity ? { verbosity } : void 0
  };
  const contextManagementEnabled =`;
    fs.writeFileSync(bundlePath, `${injectionPoint}${injectionPoint}`);

    assert.throws(
      () => patchCopilotWebSearchBundle(bundlePath),
      /Expected to find a supported Copilot Responses tool injection point/,
    );
  });

  test("should migrate legacy readable Copilot Chat development bundle patches", () => {
    const legacyReadablePatch = `  (() => {
    const sentinelToolIndex =
      body3.tools?.findIndex(
        (tool) => tool?.name === "__agent_maestro_web_search__",
      ) ?? -1;
    const sentinelTool =
      sentinelToolIndex >= 0 ? body3.tools?.[sentinelToolIndex] : undefined;
    const webSearchTool =
      sentinelTool?.parameters?.properties?.[
        "x-agent-maestro-web-search-tool"
      ]?.const;
    if (sentinelToolIndex >= 0) {
      body3.tools?.splice(sentinelToolIndex, 1);
    }
    if (
      webSearchTool &&
      typeof webSearchTool.type === "string" &&
      webSearchTool.type.startsWith("web_search")
    ) {
      const isAgentMaestroTargetModel = (value) => {
        const match = /^gpt-(\\d+)/.exec(
          String(value).toLowerCase().replace(/\\./g, "-"),
        );
        return !!match && Number(match[1]) >= 5;
      };
      if (
        (isAgentMaestroTargetModel(model) ||
          isAgentMaestroTargetModel(endpoint.family)) &&
        !body3.tools?.some(
          (tool) =>
            typeof tool?.type === "string" &&
            tool.type.startsWith("web_search"),
        )
      ) {
        body3.tools = [webSearchTool, ...(body3.tools ?? [])];
      }
    }
  })();
`;
    fs.writeFileSync(
      bundlePath,
      `function createResponsesRequestBody() {
  const body3 = {
    text: verbosity ? { verbosity } : void 0
  };
${legacyReadablePatch}  const contextManagementEnabled = true;
  return body3;
}`,
    );

    const result = patchCopilotWebSearchBundle(bundlePath);

    assert.strictEqual(result.status, "patched");
    const patchedContent = fs.readFileSync(bundlePath, "utf8");
    assert.ok(
      patchedContent.includes(READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET),
    );
    assert.ok(!patchedContent.includes(legacyReadablePatch));
  });

  test("should target GPT major version 5 and newer", () => {
    const isTargetModel = (model: string) => {
      const match = /^gpt-(\d+)/.exec(model.toLowerCase().replace(/\./g, "-"));
      return !!match && Number(match[1]) >= 5;
    };

    assert.strictEqual(isTargetModel("claude-opus-4.1"), false);
    assert.strictEqual(isTargetModel("gpt"), false);
    assert.strictEqual(isTargetModel("gpt-4.1"), false);
    assert.strictEqual(isTargetModel("gpt-5"), true);
    assert.strictEqual(isTargetModel("gpt-5.5"), true);
    assert.strictEqual(isTargetModel("GPT-6"), true);
    assert.strictEqual(isTargetModel("gpt-10-preview"), true);
  });

  test("should list backups newest first", () => {
    const olderBackup = `${bundlePath}.agent-maestro-web-search-2026-01-01T00-00-00-000Z.bak`;
    const newerBackup = `${bundlePath}.agent-maestro-web-search-2026-01-02T00-00-00-000Z.bak`;
    fs.writeFileSync(bundlePath, "current");
    fs.writeFileSync(olderBackup, "older");
    fs.writeFileSync(newerBackup, "newer");

    const olderDate = new Date("2026-01-01T00:00:00.000Z");
    const newerDate = new Date("2026-01-02T00:00:00.000Z");
    fs.utimesSync(olderBackup, olderDate, olderDate);
    fs.utimesSync(newerBackup, newerDate, newerDate);

    const backups = listCopilotWebSearchBackups(bundlePath);

    assert.deepStrictEqual(
      backups.map((backup) => backup.path),
      [newerBackup, olderBackup],
    );
  });

  test("should restore a selected backup", () => {
    const backupPath = `${bundlePath}.agent-maestro-web-search-2026-01-01T00-00-00-000Z.bak`;
    fs.writeFileSync(bundlePath, "patched");
    fs.writeFileSync(backupPath, "original");

    restoreCopilotWebSearchBackup(bundlePath, backupPath);

    assert.strictEqual(fs.readFileSync(bundlePath, "utf8"), "original");
  });

  test("should fail when the Copilot injection point changes", () => {
    fs.writeFileSync(bundlePath, "let y=[...h];let v=changed");

    assert.throws(
      () => patchCopilotWebSearchBundle(bundlePath),
      /Expected to find a supported Copilot Responses tool injection point/,
    );
  });

  test("should format Windows permission failures", () => {
    const message = getCopilotBundlePermissionMessage("win32");

    assert.ok(
      message.includes("No write access to the VS Code Copilot bundle"),
    );
    assert.ok(message.includes("Run VS Code as Administrator"));
    assert.ok(message.includes("VS Code User Installer"));
  });

  test("should format non-Windows permission failures", () => {
    const message = getCopilotBundlePermissionMessage("darwin");

    assert.ok(
      message.includes("No write access to the VS Code Copilot bundle"),
    );
    assert.ok(message.includes("user-writable VS Code install"));
    assert.ok(!message.includes("Administrator"));
  });
});
