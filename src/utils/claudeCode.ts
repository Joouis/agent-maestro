import * as vscode from "vscode";

const CLAUDE_CODE_EXTENSION_ID = "anthropic.claude-code";
const CLAUDE_V1_MAX_VERSION = "1.0.127";

const normalize = (value: string) =>
  value.split(/[.\-]/).map((segment) => Number.parseInt(segment, 10) || 0);

const isVersionGreaterThan = (version: string, baseline: string) => {
  const a = normalize(version);
  const b = normalize(baseline);
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;

    if (left > right) {
      return true;
    }

    if (left < right) {
      return false;
    }
  }

  return false;
};

export const showClaudeCodeCompatibilityWarning = () => {
  const claudeExtension = vscode.extensions.getExtension(
    CLAUDE_CODE_EXTENSION_ID,
  );

  if (!claudeExtension) {
    return;
  }

  const version = (claudeExtension.packageJSON as { version?: string })
    ?.version;

  if (!version) {
    return;
  }

  if (isVersionGreaterThan(version, CLAUDE_V1_MAX_VERSION)) {
    vscode.window.showWarningMessage(
      `Claude Code extension ${version} detected. The native v2 extension ignores LLM Gateway settings — Agent Maestro may not work as expected.`,
    );
  }
};
