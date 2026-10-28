/**
 * BOOK-DOC-4 rule 5 — the two day counters and their shared reset.
 *
 * The edit budget is counted twice (identity and network), so the moment the next edit becomes
 * possible is the later of the two resets. BOOK-158 moved the spend to acceptance, so the copy
 * that used to refuse a second edit at posting has no caller any more: the reader learns the
 * day from the budget the composer shows (`CommentBudget.editsRemaining`/`editsResetAt`).
 */

/** The later of the two edit resets: the next edit needs both counters to have a slot. */
export function laterReset(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
