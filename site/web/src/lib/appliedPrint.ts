/**
 * BOOK-DOC-84 §4/D2 — the one print path: a `chapter:applied` record → the visible blocks.
 *
 * The print's clock is `appliedAt` (the moment the revision was created), never `landed.at`:
 * the pass closes minutes after the text is live, and clocking the ink from the close is the
 * 6 s – 12 min lie D1 removes. Every changed block inside the reader's 1.5 viewports is
 * planned in document order, at most `MAX_PRINT_BLOCKS` of them, each with an absolute start
 * `appliedAt + offset` from that one clock; blocks off screen are simply set.
 *
 * Honest exits, all of them a plan of zero blocks:
 *
 *   - no applied record → no print (a page that never heard the write prints nothing);
 *   - `patchTruncated` or an unreadable pre-image (`span: null` / a truncated entry) → no plan:
 *     the page refetches the prose instead of guessing a sentence the pass did not send;
 *   - a record older than `PRINT_WINDOW_MS` (late load, reconnect, a mount that missed the
 *     window) → no plan at all: the text is there, and nothing replays (D5).
 *
 * A mount inside the window joins the current frame: `startAt` is absolute, and `frameAt`
 * clamps a negative elapsed to 0, so a late mount never restarts the ink from the beginning.
 */

import type { ChapterAppliedPayload, LiveApplied, StageSpan } from '@book/shared';

import { passSpanOf, type PassSpan } from './passDiff.ts';

/** A print older than this is never started (D5): the write is text, not motion. */
export const PRINT_WINDOW_MS = 6_000;
/** At most four blocks paint one write (D2): the pass's evidence is a handful, not a chapter. */
export const MAX_PRINT_BLOCKS = 4;
/** The whole print, offset included, stays inside this bound (D2). */
export const MAX_PRINT_MS = 12_000;
/** The breath between two changed blocks: one ink lands as the next begins. */
export const PRINT_BLOCK_STAGGER_MS = 2_600;

/** The one shape both carriers of a write share: the frame and `live.applied`. */
export type AppliedRecord = Pick<
  ChapterAppliedPayload,
  'n' | 'rev' | 'appliedAt' | 'patch' | 'patchTruncated' | 'span'
>;

/** Which blocks are inside the reader's 1.5 viewports, asked once per write. */
export type PrintViewport = (blockId: string | null) => boolean;

export type PrintPlan = {
  /** The renderer's identity: one write, one block, never re-keyed. */
  key: string;
  /** The block the write named (the pre-revision id, or `null` for a block it created). */
  blockId: string | null;
  /** The block's final text, and the span the ink lays out around. */
  before: string;
  after: string;
  span: PassSpan;
  /** Absolute epoch ms at which this block's ink starts (`appliedAt + offset`). */
  startAt: number;
};

/** Either carrier: a `chapter:applied` frame or the `live.applied` entry of `hello`. */
export type AppliedSource = AppliedRecord | LiveApplied;

/** Is the write still inside its print window at `nowMs`? Clock skew reads as "just now". */
export function printWindowOpen(record: AppliedSource | null, nowMs: number): boolean {
  if (record === null) return false;
  if (!Number.isFinite(record.appliedAt) || record.appliedAt <= 0) return false;
  return nowMs - record.appliedAt < PRINT_WINDOW_MS;
}

/** The plans for one write, in document order, bounded by D2 and by the reader's viewport. */
export function appliedPrintPlans(
  record: AppliedSource | null,
  options: { nowMs: number; visible?: PrintViewport },
): PrintPlan[] {
  if (record === null || !printWindowOpen(record, options.nowMs)) return [];
  // A cut patch or no pre-image is a guess, and the page does not print guesses: it refetches.
  if (record.patchTruncated || record.span === null) return [];
  const visible = options.visible;
  const plans: PrintPlan[] = [];
  for (const entry of record.span as readonly StageSpan[]) {
    if (plans.length >= MAX_PRINT_BLOCKS) break;
    // A truncated side is half a sentence: the rest lives in the chapter, so this block waits.
    if (entry.truncated) continue;
    if (visible !== undefined && !visible(entry.blockId)) continue;
    const span = passSpanOf(entry.before, entry.after);
    if (span === null) continue;
    const offset = Math.min(plans.length * PRINT_BLOCK_STAGGER_MS, MAX_PRINT_MS);
    plans.push({
      key: `${record.n}:${record.rev}:${entry.blockId ?? `i${plans.length}`}`,
      blockId: entry.blockId,
      before: entry.before,
      after: entry.after,
      span,
      startAt: record.appliedAt + offset,
    });
  }
  return plans;
}
