/**
 * The chapter ETag, one definition for the route that answers with it and the socket that
 * announces it (§10.3, §6F.2).
 *
 * `rev` alone is not the identity of a chapter body: a slot emptied down to its basis
 * sentence keeps its `rev` (the projection is not a revision, BOOK-6), so the frame must be
 * part of the tag — otherwise two different projections of the same chapter would carry the
 * same name, and neither a proxy log nor a probe could tell which one it holds.
 *
 * The tag is a name, not a gate: the site answers `no-store` and never replies 304 to prose
 * (BOOK-109), so a client cannot revalidate its way back to text that is no longer there.
 */

import { chapterLabel } from '@book/shared';

/** `ch01-r5-b0` — the token without quotes; the route wraps it in an HTTP entity tag. */
export function chapterEtag(n: number, rev: number, basis: boolean): string {
  return `ch${chapterLabel(n)}-r${rev}-b${basis ? 1 : 0}`;
}
