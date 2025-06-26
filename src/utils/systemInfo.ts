import * as vscode from "vscode";
import * as os from "os";
import { ExtensionController } from "../core/controller";
import type { McpServer } from "../server/McpServer";
import packageJson from "../../package.json";

export interface SystemInfo {
  name: string;
  version: string;
  extensions: {
    cline: {
      isInstalled: boolean;
      isActive: boolean;
      version: string;
    };
    roo: {
      isInstalled: boolean;
      isActive: boolean;
      version: string;
    };
  };
  vscodeVersion: string;
  os: string;
  workspace: string;
  mcpServer: {
    isRunning: boolean;
    port: number;
    url: string;
  };
  timestamp: string;
}

/**
 * Gather comprehensive system information including extension status,
 * VSCode version, OS details, workspace, and MCP server status
 */
export function getSystemInfo(
  controller: ExtensionController,
  mcpServer: McpServer,
): SystemInfo {
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

  // Get MCP server status
  const mcpStatus = mcpServer.getStatus();

  // Build response with the exact structure required
  return {
    name,
    version,
    extensions: {
      cline: {
        isInstalled: extensionStatus.cline.isInstalled,
        isActive: extensionStatus.cline.isActive,
        version: extensionStatus.cline.version || "Unknown",
      },
      roo: {
        isInstalled: extensionStatus.roo.isInstalled,
        isActive: extensionStatus.roo.isActive,
        version: extensionStatus.roo.version || "Unknown",
      },
    },
    vscodeVersion,
    os: osInfo,
    workspace,
    mcpServer: {
      isRunning: mcpStatus.isRunning,
      port: mcpStatus.port,
      url: mcpStatus.url,
    },
    timestamp: new Date().toISOString(),
  };
}
