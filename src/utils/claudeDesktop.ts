import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";

export const CLAUDE_DESKTOP_AGENT_MAESTRO_ENTRY_NAME = "agent-maestro";

export interface ClaudeDesktopConfigEntry {
  id: string;
  name: string;
}

export interface ClaudeDesktopConfigMetadata {
  appliedId: string;
  entries: ClaudeDesktopConfigEntry[];
}

export interface ClaudeDesktopGatewayConfig {
  inferenceCredentialKind: "static";
  inferenceGatewayApiKey: string;
  inferenceGatewayBaseUrl: string;
  inferenceProvider: "gateway";
}

// Claude Desktop stores third-party inference settings in this platform-specific
// local config library. See https://claude.com/docs/third-party/claude-desktop/configuration.
export function getClaudeDesktopConfigDirectory(
  platform = process.platform,
  homeDirectory = os.homedir(),
  localAppData = process.env.LOCALAPPDATA,
): string {
  switch (platform) {
    case "darwin":
      return path.join(
        homeDirectory,
        "Library",
        "Application Support",
        "Claude-3p",
        "configLibrary",
      );
    case "win32":
      return path.join(
        localAppData ?? path.join(homeDirectory, "AppData", "Local"),
        "Claude-3p",
        "configLibrary",
      );
    case "linux":
      return path.join(homeDirectory, ".config", "Claude-3p", "configLibrary");
    default:
      throw new Error(
        `Claude Desktop configuration is not supported on ${platform}.`,
      );
  }
}

export function updateClaudeDesktopMetadata(
  metadata: Partial<ClaudeDesktopConfigMetadata>,
  createId: () => string = randomUUID,
): ClaudeDesktopConfigMetadata {
  const existingEntry = metadata.entries?.find(
    (entry) => entry.name === CLAUDE_DESKTOP_AGENT_MAESTRO_ENTRY_NAME,
  );

  if (existingEntry) {
    return {
      ...metadata,
      appliedId: existingEntry.id,
      entries: metadata.entries ?? [],
    };
  }

  const id = createId();
  return {
    ...metadata,
    appliedId: id,
    entries: [
      ...(metadata.entries ?? []),
      { id, name: CLAUDE_DESKTOP_AGENT_MAESTRO_ENTRY_NAME },
    ],
  };
}

export function createClaudeDesktopGatewayConfig(
  proxyPort: number,
): ClaudeDesktopGatewayConfig {
  return {
    inferenceGatewayBaseUrl: `http://127.0.0.1:${proxyPort}/api/anthropic`,
    inferenceGatewayApiKey: "Powered by Agent Maestro",
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
  };
}
