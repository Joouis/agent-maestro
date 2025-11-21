import { RooCodeSettings } from "@roo-code/types";

/**
 * Secret state keys that should be filtered from settings responses
 * These contain sensitive API keys and credentials
 */
const SECRET_STATE_KEYS = [
  "apiKey",
  "glamaApiKey",
  "openRouterApiKey",
  "awsAccessKey",
  "awsSecretKey",
  "awsSessionToken",
  "openAiApiKey",
  "geminiApiKey",
  "openAiNativeApiKey",
  "deepSeekApiKey",
  "mistralApiKey",
  "unboundApiKey",
  "requestyApiKey",
  "xaiApiKey",
  "groqApiKey",
  "chutesApiKey",
  "litellmApiKey",
] as const;

/**
 * Filters sensitive data from RooCode settings
 * Removes:
 * - All secret state keys (API keys, credentials)
 * - taskHistory (can be very long array)
 *
 * @param settings - The settings object to filter
 * @returns A new settings object with sensitive data removed
 */
export function filterRooSettings(
  settings: RooCodeSettings,
): Partial<RooCodeSettings> {
  const filtered = { ...settings };

  // Remove all secret state keys
  for (const key of SECRET_STATE_KEYS) {
    delete (filtered as any)[key];
  }

  // Remove taskHistory as it can be very long
  delete (filtered as any).taskHistory;

  return filtered;
}
