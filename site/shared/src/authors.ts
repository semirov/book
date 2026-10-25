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

/** One reader's current trace in the final text, with its measured erosion series. */
export type AuthorContributorDto = {
  identityId: string;
  /** The chosen display name, or «читатель» after an opt-out (§6C.5 rule 5). */
  label: string;
  edits: number;
  chars: number;
  /** The share of the final text, floored to 6 decimals (§6C.5 rule 6). */
  share: number;
  firstAt: string;
  series: Array<{ day: string; edits: number; chars: number; share: number }>;
};

export type AuthorsDto = {
  /** The book's volume the shares are measured against. */
  totalChars: number;
  measuredAt: string | null;
  /** How many measured readers this list holds (before the opt-out filter). */
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
