import * as os from "os";
import * as vscode from "vscode";

import packageJson from "../../package.json";

export interface OsInfo {
  platform: string;
  arch: string;
  release: string;
  homedir: string;
}

export interface SystemInfo {
  name: string;
  version: string;
  vscodeVersion: string;
  os: OsInfo;
  workspace: string;
  timestamp: string;
}

/**
 * Gather system information: extension version, VS Code version, OS details,
 * and workspace.
 */
export function getSystemInfo(): SystemInfo {
  // Get extension name and version from package.json
  const name = packageJson.displayName || packageJson.name;
  const version = packageJson.version;

  // Get VSCode version
  const vscodeVersion = vscode.version;

  // Get OS information
  const osInfo: OsInfo = {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    homedir: os.homedir(),
  };

  // Get workspace root path
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspace = workspaceFolder?.uri.fsPath || "";

  // Build response with the exact structure required
  return {
    name,
    version,
    vscodeVersion,
    os: osInfo,
    workspace,
    timestamp: new Date().toISOString(),
  };
}
