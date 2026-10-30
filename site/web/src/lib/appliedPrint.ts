/**
 * BOOK-DOC-84 §4/D2 — the one print path: a `chapter:applied` record → the visible blocks.
 *
 * The print's clock is `appliedAt` (the moment the revision was created), never `landed.at`:
 * the pass closes minutes after the text is live, and clocking the ink from the close is the
 * 6 s – 12 min lie D1 removes. Every changed block inside the reader's 1.5 viewports is
 * planned in **document order**, with no block cap (BOOK-220 §11.2 supersedes D2's four): the
 * page prints them one at a time, the earlier place first, and each print opens when the one
 * before it settles — the chain's contract of BOOK-220 §11.2 B4: no block cap and no artificial
 * stagger. Blocks off screen are simply set.
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
  /**
   * The block as the write left it — the **post**-revision id (`applied.ts` reads `newId ?? id`,
   * and a `remove` names the block that left), or `null` when the patch names none. It is the
   * key the page's current chapter answers to once the prose is re-read.
   */
  blockId: string | null;
  /** The block's final text, and the span the ink lays out around. */
  before: string;
  after: string;
  span: PassSpan;
  /**
   * Absolute epoch ms at which this block's ink starts. For the first plan of a write it is
   * `appliedAt`; a later plan is started by the page when the print before it settles.
   */
  startAt: number;
  /** The plan's place in document order: the chain prints 0, then 1, then 2 … */
  order: number;
};

/** Either carrier: a `chapter:applied` frame or the `live.applied` entry of `hello`. */
export type AppliedSource = AppliedRecord | LiveApplied;

/** Is the write still inside its print window at `nowMs`? Clock skew reads as "just now". */
export function printWindowOpen(record: AppliedSource | null, nowMs: number): boolean {
  if (record === null) return false;
  if (!Number.isFinite(record.appliedAt) || record.appliedAt <= 0) return false;
  return nowMs - record.appliedAt < PRINT_WINDOW_MS;
}

/** The plans for one write, in document order, bounded only by the reader's viewport. */
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
    // A truncated side is half a sentence: the rest lives in the chapter, so this block waits.
    if (entry.truncated) continue;
    if (visible !== undefined && !visible(entry.blockId)) continue;
    const span = passSpanOf(entry.before, entry.after);
    if (span === null) continue;
    plans.push({
      key: `${record.n}:${record.rev}:${entry.blockId ?? `i${plans.length}`}`,
      blockId: entry.blockId,
      before: entry.before,
      after: entry.after,
      span,
      startAt: record.appliedAt,
      order: plans.length,
    });
  }
  return plans;
}
