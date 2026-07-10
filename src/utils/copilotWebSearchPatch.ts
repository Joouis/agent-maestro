import * as fs from "fs";
import * as path from "path";

import {
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER,
  AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME,
} from "./copilotWebSearchConstants";

const COPILOT_BUNDLE_RELATIVE_PATH = path.join(
  "extensions",
  "copilot",
  "dist",
  "extension.js",
);

const TOOL_SEARCH_SNIPPET =
  'let y=[...h];g&&y.unshift({type:"tool_search",execution:"client",description:"Search for relevant tools by describing what you need. Returns tool definitions for tools matching your query.",parameters:{type:"object",properties:{query:{type:"string",description:"Natural language description of what tool capability you are looking for."}},required:["query"]}});';

const TOOL_MAP_SNIPPET =
  "let v=e.requestOptions?.tools?new Map(e.requestOptions.tools.map(B=>[B.function.name,B])):void 0";

export const GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET = `(()=>{let B=y.findIndex(ee=>ee?.name==="${AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME}"),X=B>=0?y[B]:void 0,Q=X?.parameters?.properties?.["${AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER}"]?.const;B>=0&&y.splice(B,1);if(Q&&typeof Q.type=="string"&&Q.type.startsWith("web_search")){e.postOptions?.tool_choice?.function?.name==="${AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME}"&&(e.postOptions.tool_choice="required");((ee=>{let te=/^gpt-(\\d+)/.exec(String(ee).toLowerCase().replace(/\\./g,"-"));return!!te&&Number(te[1])>=5})(t)||(ee=>{let te=/^gpt-(\\d+)/.exec(String(ee).toLowerCase().replace(/\\./g,"-"));return!!te&&Number(te[1])>=5})(r.family))&&!y.some(ee=>typeof ee?.type=="string"&&ee.type.startsWith("web_search"))&&y.unshift(Q)}})();`;

const READABLE_RESPONSES_BODY_SNIPPET = `    text: verbosity ? { verbosity } : void 0
  };
  const contextManagementEnabled =`;

const READABLE_RESPONSES_BODY_END_SNIPPET = `    text: verbosity ? { verbosity } : void 0
  };
`;

const READABLE_CONTEXT_MANAGEMENT_SNIPPET =
  "  const contextManagementEnabled =";

export const READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET = `  (() => {
    const sentinelToolIndex =
      body3.tools?.findIndex(
        (tool) => tool?.name === "${AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME}",
      ) ?? -1;
    const sentinelTool =
      sentinelToolIndex >= 0 ? body3.tools?.[sentinelToolIndex] : undefined;
    const webSearchTool =
      sentinelTool?.parameters?.properties?.[
        "${AGENT_MAESTRO_WEB_SEARCH_SENTINEL_PARAMETER}"
      ]?.const;
    if (sentinelToolIndex >= 0) {
      body3.tools?.splice(sentinelToolIndex, 1);
    }
    if (body3.tool_choice?.name === "${AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME}") {
      body3.tool_choice = "required";
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

export interface CopilotBundlePathOptions {
  appRoot: string;
  extensionPath?: string;
  extensionMain?: string;
}

export interface CopilotWebSearchPatchResult {
  status: "patched" | "already-patched";
  bundlePath: string;
  backupPath?: string;
}

export interface CopilotWebSearchBackupInfo {
  path: string;
  createdAtMs: number;
}

export function getCopilotBundlePath(appRoot: string): string {
  if (!appRoot) {
    throw new Error(
      "VS Code app root is unavailable. This command only works in desktop VS Code.",
    );
  }

  return path.join(appRoot, COPILOT_BUNDLE_RELATIVE_PATH);
}

export function getRunningCopilotBundlePath({
  appRoot,
  extensionPath,
  extensionMain,
}: CopilotBundlePathOptions): string {
  const loadedExtensionBundlePath = getLoadedExtensionBundlePath(
    extensionPath,
    extensionMain,
  );
  return loadedExtensionBundlePath ?? getCopilotBundlePath(appRoot);
}

export function patchCopilotWebSearchBundle(
  bundlePath: string,
): CopilotWebSearchPatchResult {
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Copilot bundle not found: ${bundlePath}`);
  }

  const content = fs.readFileSync(bundlePath, "utf8");

  if (
    content.includes(GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET) ||
    content.includes(READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET)
  ) {
    return {
      status: "already-patched",
      bundlePath,
    };
  }

  const patchedContent =
    patchMinifiedResponsesBundle(content) ??
    patchReadableResponsesBundle(content);

  if (patchedContent) {
    let backupPath: string;

    try {
      backupPath = createBundleBackup(bundlePath);
      fs.writeFileSync(bundlePath, patchedContent);
    } catch (error) {
      throwCopilotBundleWriteError(error);
    }

    return {
      status: "patched",
      bundlePath,
      backupPath,
    };
  }

  throw new Error(
    "Expected to find a supported Copilot Responses tool injection point. VS Code may have updated its Copilot bundle.",
  );
}

function patchMinifiedResponsesBundle(content: string): string | undefined {
  const targetSnippet = `${TOOL_SEARCH_SNIPPET}${TOOL_MAP_SNIPPET}`;
  const replacement = `${TOOL_SEARCH_SNIPPET}${GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET}${TOOL_MAP_SNIPPET}`;
  const firstMatch = content.indexOf(targetSnippet);

  if (firstMatch >= 0 && firstMatch === content.lastIndexOf(targetSnippet)) {
    return content.replace(targetSnippet, replacement);
  }

  const legacyPatchResult = replaceLegacyPatch(content);
  if (legacyPatchResult) {
    return legacyPatchResult;
  }

  return undefined;
}

function patchReadableResponsesBundle(content: string): string | undefined {
  const replacement = `${READABLE_RESPONSES_BODY_SNIPPET.replace(
    "  const contextManagementEnabled =",
    "",
  )}${READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET}  const contextManagementEnabled =`;
  const firstMatch = content.indexOf(READABLE_RESPONSES_BODY_SNIPPET);

  if (
    firstMatch >= 0 &&
    firstMatch === content.lastIndexOf(READABLE_RESPONSES_BODY_SNIPPET)
  ) {
    return content.replace(READABLE_RESPONSES_BODY_SNIPPET, replacement);
  }

  return replaceReadableLegacyPatch(content);
}

function replaceReadableLegacyPatch(content: string): string | undefined {
  const bodyEndIndex = content.indexOf(READABLE_RESPONSES_BODY_END_SNIPPET);
  if (bodyEndIndex < 0) {
    return undefined;
  }

  const legacyPatchStart =
    bodyEndIndex + READABLE_RESPONSES_BODY_END_SNIPPET.length;
  const contextManagementIndex = content.indexOf(
    READABLE_CONTEXT_MANAGEMENT_SNIPPET,
    legacyPatchStart,
  );
  if (contextManagementIndex < 0) {
    return undefined;
  }

  const legacyPatch = content.slice(legacyPatchStart, contextManagementIndex);
  if (!isLegacyWebSearchPatch(legacyPatch)) {
    return undefined;
  }

  return `${content.slice(0, legacyPatchStart)}${READABLE_GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET}${content.slice(contextManagementIndex)}`;
}

function replaceLegacyPatch(content: string): string | undefined {
  const toolSearchIndex = content.indexOf(TOOL_SEARCH_SNIPPET);
  if (toolSearchIndex < 0) {
    return undefined;
  }

  const legacyPatchStart = toolSearchIndex + TOOL_SEARCH_SNIPPET.length;
  const toolMapIndex = content.indexOf(TOOL_MAP_SNIPPET, legacyPatchStart);
  if (toolMapIndex < 0) {
    return undefined;
  }

  const legacyPatch = content.slice(legacyPatchStart, toolMapIndex);
  if (!isLegacyWebSearchPatch(legacyPatch)) {
    return undefined;
  }

  return `${content.slice(0, legacyPatchStart)}${GPT5_PLUS_WEB_SEARCH_PATCH_SNIPPET}${content.slice(toolMapIndex)}`;
}

function isLegacyWebSearchPatch(snippet: string): boolean {
  if (!snippet.includes('type.startsWith("web_search")')) {
    return false;
  }

  return (
    snippet.includes('y.unshift({type:"web_search_preview"})') ||
    snippet.includes("agentMaestroWebSearchTool") ||
    snippet.includes(AGENT_MAESTRO_WEB_SEARCH_SENTINEL_TOOL_NAME)
  );
}

export function listCopilotWebSearchBackups(
  bundlePath: string,
): CopilotWebSearchBackupInfo[] {
  const bundleDir = path.dirname(bundlePath);
  const bundleBaseName = path.basename(bundlePath);
  const backupPrefix = `${bundleBaseName}.agent-maestro-web-search-`;

  if (!fs.existsSync(bundleDir)) {
    return [];
  }

  return fs
    .readdirSync(bundleDir)
    .filter((entry) => entry.startsWith(backupPrefix) && entry.endsWith(".bak"))
    .map((entry) => {
      const backupPath = path.join(bundleDir, entry);
      return {
        path: backupPath,
        createdAtMs: fs.statSync(backupPath).mtimeMs,
      };
    })
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function restoreCopilotWebSearchBackup(
  bundlePath: string,
  backupPath: string,
): void {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }

  try {
    fs.copyFileSync(backupPath, bundlePath);
  } catch (error) {
    throwCopilotBundleWriteError(error);
  }
}

function throwCopilotBundleWriteError(error: unknown): never {
  if (isPermissionError(error)) {
    throw new Error(getCopilotBundlePermissionMessage());
  }

  throw error;
}

function isPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EPERM";
}

export function getCopilotBundlePermissionMessage(
  platform: NodeJS.Platform = process.platform,
): string {
  const permissionHint =
    platform === "win32"
      ? "Run VS Code as Administrator or use the VS Code User Installer, then try again."
      : "Restart VS Code with write access to the app bundle, or use a user-writable VS Code install.";

  return `No write access to the VS Code Copilot bundle. ${permissionHint}`;
}

function createBundleBackup(bundlePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${bundlePath}.agent-maestro-web-search-${timestamp}.bak`;
  fs.copyFileSync(bundlePath, backupPath);
  return backupPath;
}

function getLoadedExtensionBundlePath(
  extensionPath?: string,
  extensionMain?: string,
): string | undefined {
  if (!extensionPath || !extensionMain) {
    return undefined;
  }

  const mainPath = path.isAbsolute(extensionMain)
    ? extensionMain
    : path.resolve(extensionPath, extensionMain);
  const candidates = path.extname(mainPath)
    ? [mainPath]
    : [`${mainPath}.js`, `${mainPath}.cjs`, `${mainPath}.mjs`, mainPath];

  return candidates.find((candidate) => fs.existsSync(candidate));
}
