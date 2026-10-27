/**
 * The authors list at the end of the book (ARCHITECTURE.md §6C.5).
 *
 * Two rules shape this shape. The **author is the remainder**: the copyright line names
 * «Филипп Семиров», so the book must never read as co-authored in law — every reader's
 * share is measured, floored to six decimals, and the author takes whatever is left. And
 * the list is **deterministic**: the same database gives the same list, in the same order,
 * with the same numbers. A share that wobbles on reload is worse than no share.
 *
 * The writer, the editor and the consultant are not persons and are not listed: they are
 * the tool by which the author and the readers write (§6C.5 rule 3).
 */

import type { ContributorPointDto } from './history.ts';

/**
 * One reader's surviving trace in the final text. The public list carries no erosion
 * series: a day-by-day curve is the reader's own behaviour, and it is served only to them
 * (`MyTraceDto`). The list is the surviving-text list, so a reader with zero surviving
 * characters is not a row — the byline and the list then state the same thing.
 */
export type AuthorContributorDto = {
  /** A public alias — `sha256(identityId)` truncated, never the identity key (audit m3). */
  identityId: string;
  /** The chosen display name, or «читатель» after an opt-out (§6C.5 rule 5). */
  label: string;
  edits: number;
  chars: number;
  /** The share of the final text, floored to 6 decimals (§6C.5 rule 6). */
  share: number;
  firstAt: string;
};

export type AuthorsDto = {
  /** The book's volume the shares are measured against. */
  totalChars: number;
  measuredAt: string | null;
  /** How many readers the measurement holds, before the opt-out and surviving-text filters. */
  measured: number;
  author: {
    label: string;
    /** `1 − Σ contributor shares`, never below zero (§6C.5 rule 2). */
    share: number;
    /** Characters whose last cause is not a reader's change. */
    chars: number;
  };
  /** Descending share, ties broken by `firstAt` then label — one stable order. */
  contributors: AuthorContributorDto[];
  /** Σ of the listed shares plus the author's: exactly 1 for a non-empty book. */
  sum: number;
};

/**
 * The title page's live byline count — «Филипп Семиров + N» (BOOK-DOC-4).
 *
 * N is the number of readers with **at least one surviving character** in the current text:
 * the same measurement the authors list uses, minus the hidden readers, so the byline and
 * the list cannot disagree. The writer, the editor and the consultant never count.
 *
 * `measuredAt` is the monotonic marker: the client keeps the newest count and ignores an
 * older frame, so a reordered reconnect cannot make the byline regress.
 */
export type AuthorsCountDto = {
  count: number;
  measuredAt: string;
};

/**
 * One signed-in reader's own trace (`GET /api/authors/me`) — own only, never another
 * reader's, and it carries no identity key: the display name is the only public handle.
 *
 * `survivedRevisions` is the honest «пережила N ревизий»: how many chapter revisions the
 * reader's currently surviving characters have lived through — every revision of their
 * chapter after the one that wrote a surviving paragraph, over distinct chapter revisions.
 * It is `0` when nothing of theirs survives; it is never modelled.
 */
export type MyTraceDto = {
  label: string;
  edits: number;
  chars: number;
  /** The same floored share the authors list prints, so the two cannot disagree. */
  share: number;
  /** The measured days, not a curve drawn between two numbers. */
  series: ContributorPointDto[];
  hidden: boolean;
  survivedRevisions: number;
};

/** Shares are printed to six decimals; floor keeps Σ from drifting above 1. */
export const SHARE_SCALE = 1_000_000;

export function floorShare(share: number): number {
  if (!Number.isFinite(share) || share <= 0) return 0;
  if (share >= 1) return 1;
  return Math.floor(share * SHARE_SCALE) / SHARE_SCALE;
}

/** The end-matter percentage: «12,4 %», Russian decimal comma, one decimal. */
export function formatShare(share: number): string {
  const percent = Math.round(share * 1_000) / 10;
  return `${percent.toFixed(1).replace('.', ',')} %`;
}
