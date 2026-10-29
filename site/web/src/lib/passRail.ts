import type { PassStageEvent } from '@book/shared';

import { passSpanOf, type PassSpan } from './passDiff.ts';

/**
 * The live block: what a running pass is writing, as the page paints it.
 *
 * What remains after BOOK-207 is the one thing the prose needs: which block a pass is writing
 * and from when. The rail, the strip and the ledger are gone; the stage vocabulary, durations
 * and costs live only in the operator's console (`bin/admin.mjs`).
 */

const byStage = (left: PassStageEvent, right: PassStageEvent): number =>
  left.at - right.at || left.stageSeq - right.stageSeq;

/** The chapter's log, narrowed to one pass, in stage order. */
function eventsOfPass(events: readonly PassStageEvent[], passId: string): PassStageEvent[] {
  return events.filter((event) => event.passId === passId).sort(byStage);
}

/** What a running pass puts on the page: one block, replaced, from the moment of its event. */
export type LivePassSpec = {
  /**
   * The pass's own id — the renderer's identity. One pass is one renderer: the stages that
   * follow the landing (`typing`) say when the browser prints, never that a second pass began.
   */
  key: string;
  before: string;
  after: string;
  startAt: number;
  /** The block the pass named — the pre-revision id, which is what the page still holds. */
  blockId: string | null;
  /** The stage's side was cut at the bound: the span is not the whole paragraph. */
  truncated: boolean;
};

/**
 * The pass the page is printing, from the stages it holds: the newest pass that reached the
 * text, its landed span, and the moment the browser started printing (`typing`), falling back
 * to the landing itself. No span, no spec — a pass that only read has no text to paint.
 *
 * A revision without a `pass:stage` therefore never reaches this function: the page keeps its
 * ordinary revision behaviour and never re-types old text.
 */
export function livePassOf(events: readonly PassStageEvent[]): LivePassSpec | null {
  const ordered = [...events].sort(byStage);
  const trigger = [...ordered].reverse().find((event) => event.stage === 'typing' || event.stage === 'landed');
  if (trigger === undefined) return null;
  const own = eventsOfPass(ordered, trigger.passId);
  const landed = [...own].reverse().find((event) => event.stage === 'landed' && (event.span?.length ?? 0) > 0);
  if (landed === undefined || landed.span === null) return null;
  // The words the pass wrote. An entry whose `after` is empty only removed text: the deletion
  // is the span the renderer paints as a ghost, so it is the fallback, not a skip.
  const entry =
    landed.span.find((item) => item.after.trim().length > 0) ??
    landed.span.find((item) => item.before.trim().length > 0);
  if (entry === undefined) return null;
  const typing = [...own].reverse().find((event) => event.stage === 'typing');
  const started = typing !== undefined && typing.at >= landed.at;
  return {
    // Keyed by the pass, never by a stage: `typing` arrives after `landed` (the tailer publishes
    // in seq order), and a re-keyed renderer would blank and re-type a paragraph already inked.
    key: landed.passId,
    before: entry.before,
    after: entry.after,
    startAt: started ? typing!.at : landed.at,
    blockId: entry.blockId,
    truncated: entry.truncated,
  };
}

/**
 * The words this block of the page is being written into, or null when the block is not the
 * one the pass touched.
 *
 * Two shapes are honest. Before the chapter refetches, the page still holds the block the pass
 * named by id, and the span's `after` is the text to paint. After the refetch, that block is
 * gone and its successor has the new text; the successor is matched by the text itself. A
 * truncated span is not used as a paragraph body: the rest of it lives in the chapter, and the
 * page waits for the chapter instead of printing a cut sentence.
 */
export function liveRunOf(
  spec: LivePassSpec,
  block: { id: string; text: string },
): { text: string; span: PassSpan } | null {
  const named = spec.blockId !== null && block.id === spec.blockId;
  if (named) {
    if (spec.truncated) return null;
    const span = passSpanOf(spec.before, spec.after);
    return span === null ? null : { text: spec.after, span };
  }
  if (block.text.trim() !== spec.after.trim()) return null;
  const span = passSpanOf(spec.before, block.text);
  return span === null ? null : { text: block.text, span };
}
