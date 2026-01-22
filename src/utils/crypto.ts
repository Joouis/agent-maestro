import { timingSafeEqual } from "crypto";

/**
 * Performs a constant-time string comparison to prevent timing attacks.
 * This should be used for comparing sensitive data like API keys.
 *
 * Note: We compare buffer byte lengths (not string lengths) because
 * UTF-16 code units can map to different UTF-8 byte lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
