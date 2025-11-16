import { promises as fs } from "fs";
import { dirname } from "path";

/**
 * Updates or creates a .env file with the specified key-value pairs.
 *
 * @param path - The path to the .env file
 * @param updates - Record of key-value pairs to update or add
 * @param preserveKeys - Keys that should NOT be overwritten if they already exist in the file (their existing values will be preserved)
 * @returns Promise that resolves when the file has been written
 * @throws Error if file cannot be read or written (except ENOENT which creates a new file)
 *
 * @remarks
 * - If the file doesn't exist, it will be created
 * - Existing comments and blank lines are preserved
 * - Keys in `updates` but not in `preserveKeys` will be updated or added
 * - Keys in both `updates` and `preserveKeys` will only be added if they don't exist
 *
 * @example
 * // Update or create .env file, preserving existing API_KEY if present
 * await updateEnvFile('/path/to/.env', {
 *   API_ENDPOINT: 'http://localhost:3000',
 *   API_KEY: 'default-key'
 * }, ['API_KEY']);
 */
export async function updateEnvFile(
  path: string,
  updates: Record<string, string>,
  preserveKeys?: string[],
): Promise<void> {
  let lines: string[] = [];

  // Read file if it exists
  try {
    const content = await fs.readFile(path, "utf8");
    lines = content.split(/\r?\n/);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      throw err;
    }
    // If file doesn't exist, start fresh
  }

  const keys = Object.keys(updates);
  const updated = new Set<string>();

  // Modify existing key lines
  const newLines = lines.map((line) => {
    const match = line.match(/^([^#=\s]+)\s*=/);
    if (!match) {
      return line;
    } // keep comments/blank lines

    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      updated.add(key);

      // If key should be preserved and already exists, keep the original line
      if (preserveKeys && preserveKeys.includes(key)) {
        return line;
      }

      return `${key}=${updates[key]}`;
    }

    return line;
  });

  // Append missing keys
  for (const key of keys) {
    if (!updated.has(key)) {
      newLines.push(`${key}=${updates[key]}`);
    }
  }

  // Ensure parent directory exists before writing
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(path, newLines.join("\n"), "utf8");
}
