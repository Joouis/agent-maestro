import { promises as fs } from "fs";

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
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
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

  await fs.writeFile(path, newLines.join("\n"), "utf8");
}
