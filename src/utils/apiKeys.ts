import { randomBytes } from "crypto";

export const ADMIN_API_KEY_MIN_LENGTH = 16;

/** `am_` + 32 random bytes as base64url (46 characters). */
export function generateApiKey(): string {
  return `am_${randomBytes(32).toString("base64url")}`;
}

/**
 * Returns an error message, or `undefined` when the key is acceptable.
 * HTTP header values must be ASCII; a key outside printable ASCII could be
 * saved but never sent by a client.
 */
export function validateAdminApiKey(key: string): string | undefined {
  if (!/^[\x21-\x7e]*$/.test(key)) {
    return "The key must use printable ASCII characters only, with no spaces.";
  }
  if (key.length < ADMIN_API_KEY_MIN_LENGTH) {
    return `The key must be at least ${ADMIN_API_KEY_MIN_LENGTH} characters.`;
  }
  return undefined;
}
