/**
 * Constant-time comparison of a presented credential (ARCHITECTURE.md §17, audit m6).
 *
 * A bearer token compared with `===` leaks its prefix through timing: the comparison stops
 * at the first differing byte, so a long enough sample tells an attacker the prefix. Both
 * the admin panel and the engine's internal API compare through this one function.
 *
 * The length is hidden too — a length oracle is a prefix oracle: a wrong length still
 * performs one comparison of the expected length, so the work does not depend on the guess.
 */

import { timingSafeEqual } from 'node:crypto';

export function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length === 0) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(presented, 'utf8');
  if (left.length !== right.length) {
    // Still compare something of the same length, so the work does not depend on the guess.
    const padded = Buffer.alloc(left.length);
    right.copy(padded, 0, 0, Math.min(right.length, left.length));
    timingSafeEqual(left, padded);
    return false;
  }
  return timingSafeEqual(left, right);
}
