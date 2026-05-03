/**
 * Shared helpers for the Claude Code 1M-context detection suffix.
 *
 * Claude Code (CC) decides whether to enable its 1M-context code path by
 * inspecting the configured model name (e.g. ANTHROPIC_MODEL). We tag
 * 1M-capable model IDs with a `[1m]` suffix when writing settings, and strip
 * it on inbound proxy requests before model resolution.
 */

export const CC_1M_SUFFIX = "[1m]";

/**
 * Remove the trailing `[1m]` suffix that the client may echo back.
 * Returns the input unchanged if it is not a non-empty string, so callers in
 * routes that skip schema validation don't crash on missing/invalid `model`.
 */
export function stripCc1mSuffix(model: unknown): string {
  if (typeof model !== "string") {
    return model as string;
  }
  return model.endsWith(CC_1M_SUFFIX)
    ? model.slice(0, -CC_1M_SUFFIX.length)
    : model;
}

/**
 * Append `[1m]` to a model ID that targets the 1M-context variant, so Claude
 * Code enables its 1M-context code path. Idempotent. Detection matches the
 * convention used elsewhere in the proxy: any `-1m` segment in the ID marks
 * a 1M variant (e.g. `claude-opus-4.7-1m-internal`), not just a terminal one.
 */
export function tagCc1mSuffix(modelId: string): string {
  if (!modelId.includes("-1m") || modelId.endsWith(CC_1M_SUFFIX)) {
    return modelId;
  }
  return `${modelId}${CC_1M_SUFFIX}`;
}
