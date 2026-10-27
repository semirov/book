/**
 * The title page's live byline count (BOOK-DOC-4): «Филипп Семиров + N».
 *
 * The count is a measurement, so the page keeps the newest one: `measuredAt` is the
 * server's monotonic marker, and a frame older than the number already on the page is
 * ignored. Without this, a reconnect whose `hello` crosses a live `authors:update` could
 * make N go backwards — the one thing a live counter must never do.
 */

import type { AuthorsCountDto } from '@book/shared';

/** A count is a whole, non-negative number of readers; anything else is not a measurement. */
export function isAuthorsCount(value: unknown): value is AuthorsCountDto {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { count?: unknown; measuredAt?: unknown };
  return (
    typeof candidate.count === 'number' &&
    Number.isInteger(candidate.count) &&
    candidate.count >= 0 &&
    typeof candidate.measuredAt === 'string'
  );
}

/**
 * The number page 1 should show. `measuredAt` is ISO-8601 UTC, so string order is time
 * order; an equal marker changes nothing (the same measurement, never a correction).
 */
export function newestAuthorsCount(
  current: AuthorsCountDto | null | undefined,
  next: unknown,
): AuthorsCountDto {
  const held = current ?? { count: 0, measuredAt: '' };
  if (!isAuthorsCount(next)) return held;
  if (next.measuredAt <= held.measuredAt) return held;
  return next;
}
