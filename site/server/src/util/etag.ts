/**
 * The chapter ETag, one definition for the route that answers with it and the socket that
 * announces it (§10.3, §6F.2).
 *
 * `rev` alone is not the identity of a chapter body: a slot emptied down to its basis
 * sentence keeps its `rev` (the projection is not a revision, BOOK-6), so the frame must be
 * part of the tag — otherwise a browser revalidates a 200 it cached from the prose, gets 304
 * and keeps showing text that is no longer there.
 */

import { chapterLabel } from '@book/shared';

/** `ch01-r5-b0` — the token without quotes; the route wraps it in an HTTP entity tag. */
export function chapterEtag(n: number, rev: number, basis: boolean): string {
  return `ch${chapterLabel(n)}-r${rev}-b${basis ? 1 : 0}`;
}
