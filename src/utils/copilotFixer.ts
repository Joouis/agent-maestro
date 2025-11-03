import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface CopilotExtensionInfo {
  found: boolean;
  path?: string;
  version?: string;
  extensionJsPath?: string;
}

export interface BackupResult {
  success: boolean;
  backupPath?: string;
  error?: string;
}

export interface FixResult {
  success: boolean;
  message: string;
  backupPath?: string;
  originalContent?: string;
  modifiedContent?: string;
}

/**
 * Find the GitHub Copilot Chat extension directory
 */
export function findCopilotChatExtension(): CopilotExtensionInfo {
  const extensionsDir = path.join(os.homedir(), ".vscode", "extensions");

  try {
    if (!fs.existsSync(extensionsDir)) {
      return { found: false };
    }

    const entries = fs.readdirSync(extensionsDir);
    const copilotDirs = entries
      .filter((entry) => entry.startsWith("github.copilot-chat-"))
      .map((entry) => {
        const match = entry.match(/github\.copilot-chat-(.+)/);
        return {
          name: entry,
          version: match ? match[1] : "unknown",
          path: path.join(extensionsDir, entry),
        };
      })
      .sort((a, b) => b.version.localeCompare(a.version)); // Sort by version descending

    if (copilotDirs.length === 0) {
      return { found: false };
    }

    // Use the most recent version
    const latestExtension = copilotDirs[0];
    const extensionJsPath = path.join(
      latestExtension.path,
      "dist",
      "extension.js",
    );

    if (!fs.existsSync(extensionJsPath)) {
      return {
        found: true,
        path: latestExtension.path,
        version: latestExtension.version,
      };
    }

    return {
      found: true,
      path: latestExtension.path,
      version: latestExtension.version,
      extensionJsPath,
    };
  } catch (error) {
    return { found: false };
  }
}

/**
 * Create a backup of the extension.js file
 */
export function backupExtensionFile(filePath: string): BackupResult {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${filePath}.backup-${timestamp}`;

    fs.copyFileSync(filePath, backupPath);

    return {
      success: true,
      backupPath,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Find and remove the x-onbehalf-extension-id header from extension.js
 */
export function findAndRemoveHeader(filePath: string): FixResult {
  try {
    // Read the file content
    const content = fs.readFileSync(filePath, "utf8");

    // Pattern to match: ,"x-onbehalf-extension-id":`${A}/${c}`
    // We need to be careful with the exact pattern as the file is minified
    const headerPattern =
      /,"x-onbehalf-extension-id":`\$\{[A-Za-z]\}\/\$\{[A-Za-z]\}`/;

    if (!headerPattern.test(content)) {
      // Check if it might have already been removed
      if (content.includes("x-onbehalf-extension-id")) {
        return {
          success: false,
          message:
            "Found 'x-onbehalf-extension-id' in the file but the pattern doesn't match the expected format. The extension may have been updated.",
        };
      }

      return {
        success: false,
        message:
          "Header pattern not found. It may have already been removed or the extension version is different.",
      };
    }

    // Verify the context around the pattern to ensure we're modifying the right place
    const contextPattern =
      /S==="getExtraHeaders"\?function\(\)\{return\{\.\.\.f\.getExtraHeaders\?\.\(\)(?:\?\?|\|\|)\{\},"x-onbehalf-extension-id":`\$\{[A-Za-z]\}\/\$\{[A-Za-z]\}`\}\}/;

    if (!contextPattern.test(content)) {
      // Try a more lenient pattern
      const lenientPattern =
        /getExtraHeaders.*?"x-onbehalf-extension-id":`\$\{[A-Za-z]\}\/\$\{[A-Za-z]\}`/;
      if (!lenientPattern.test(content)) {
        return {
          success: false,
          message:
            "Found the header but couldn't verify the surrounding context. Manual review recommended.",
        };
      }
    }

    // Remove the header (including the comma)
    const modifiedContent = content.replace(headerPattern, "");

    // Verify the modification was made
    if (modifiedContent === content) {
      return {
        success: false,
        message: "Failed to modify content. No changes were made.",
      };
    }

    // Write the modified content back
    fs.writeFileSync(filePath, modifiedContent, "utf8");

    return {
      success: true,
      message: "Successfully removed x-onbehalf-extension-id header",
      originalContent: content,
      modifiedContent,
    };
  } catch (error) {
    return {
      success: false,
      message: `Error processing file: ${(error as Error).message}`,
    };
  }
}

/**
 * Verify that the fix was applied correctly
 */
export function verifyCopilotFix(filePath: string): {
  verified: boolean;
  message: string;
} {
  try {
    const content = fs.readFileSync(filePath, "utf8");

    // Check if the header pattern is still present
    const headerPattern =
      /,"x-onbehalf-extension-id":`\$\{[A-Za-z]\}\/\$\{[A-Za-z]\}`/;

    if (headerPattern.test(content)) {
      return {
        verified: false,
        message: "Header is still present in the file",
      };
    }

    // Check if getExtraHeaders still exists (it should)
    if (!content.includes("getExtraHeaders")) {
      return {
        verified: false,
        message:
          "getExtraHeaders function not found - file may have been corrupted",
      };
    }

    return {
      verified: true,
      message: "Fix verified successfully",
    };
  } catch (error) {
    return {
      verified: false,
      message: `Verification failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Restore from backup
 */
export function restoreFromBackup(
  originalPath: string,
  backupPath: string,
): { success: boolean; error?: string } {
  try {
    fs.copyFileSync(backupPath, originalPath);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}
