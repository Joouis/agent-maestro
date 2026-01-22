import { timingSafeEqual } from "crypto";

/**
 * Performs a constant-time string comparison to prevent timing attacks.
 * This should be used for comparing sensitive data like API keys.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}
