/**
 * Persisted IP identity (ARCHITECTURE.md §14): only `HMAC-SHA256(salt, ipKey)` is stored,
 * never the address. The salt lives in a `0600` file in deployment; an ephemeral salt is
 * acceptable locally because it only weakens restart-durable rate windows.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function ephemeralSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createIpHasher(salt: string): (ipKey: string) => string {
  return (ipKey: string) => createHmac('sha256', salt).update(ipKey, 'utf8').digest('hex');
}

/** Constant-time comparison for two hex/base64url digests of equal length. */
export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
