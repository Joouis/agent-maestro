import * as vscode from "vscode";
import * as os from "os";
import { ExtensionController } from "../core/controller";
import packageJson from "../../package.json";

export interface ExtensionStatus {
  isInstalled: boolean;
  isActive: boolean;
  version?: string;
}

export interface SystemInfo {
  name: string;
  version: string;
  extensions: {
    [ext: string]: ExtensionStatus;
  };
  vscodeVersion: string;
  os: string;
  workspace: string;
  timestamp: string;
}

/**
 * Gather comprehensive system information including extension status,
 * VSCode version, OS details, workspace, and MCP server status
 */
export function getSystemInfo(controller: ExtensionController): SystemInfo {
  // Get extension name and version from package.json
  const name = packageJson.displayName || packageJson.name;
  const version = packageJson.version;

  // Get extension status from controller
  const extensionStatus = controller.getExtensionStatus();

  // Get VSCode version
  const vscodeVersion = vscode.version;

  // Get OS information in the format: "Platform Architecture Release"
  // Convert platform names to match expected format
  const platform = os.platform();
  let platformName: string = platform;
  if (platform === "darwin") {
    platformName = "Darwin";
  } else if (platform === "win32") {
    platformName = "Windows";
  } else if (platform === "linux") {
    platformName = "Linux";
  }

  const arch = os.arch();
  const release = os.release();
  const osInfo = `${platformName} ${arch} ${release}`;

  // Get workspace root path
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspace = workspaceFolder?.uri.fsPath || "";

  // Build response with the exact structure required
  return {
    name,
    version,
    extensions: {
      ...extensionStatus,
    },
    vscodeVersion,
    os: osInfo,
    workspace,
    timestamp: new Date().toISOString(),
  };
}
