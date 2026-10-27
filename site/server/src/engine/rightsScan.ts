/**
 * Gate B on the prose surface, as one decision about one step (BOOK-61, BOOK-DOC-42 §1).
 *
 * Two callers, one rule:
 *   • `land` scans the blocks a step **wrote** — those whose hash is absent from the pre-image
 *     `start` captured — and refuses the land outright on a non-releasable rule;
 *   • `close` scans a step that landed **before** this deploy (`rights_scan IS NULL`), so an
 *     in-flight step cannot close without Gate B (BOOK-61 review B3). The text is already
 *     published there, so nothing is refused: a hit becomes a flag and the gate answers.
 *
 * The delta, not the chapter, is what is asked about: a range that did not move keeps the
 * verdict it had, and an already-written chapter is never re-judged as a whole (§1).
 */

import { isListRefusal, rightsRefusalLine, RIGHTS_COPY } from '../rights/rules.ts';
import { scanRights } from '../rights/scan.ts';
import { deltaBlocks } from './helpers.ts';
import * as store from './store.ts';
import { isWrittenChapter, readChapter } from './text.ts';
import type { EngineDeps } from './types.ts';

export type LandingScan = {
  /** The fixed sentence for a non-releasable hit: the land is refused with it, nothing written. */
  refusal: string | null;
  rule: string | null;
  block: number | null;
  /** What `steps.rights_scan` is written as; `null` for a pass that writes no prose of its own. */
  stored: string | null;
};

/** The stored form of one scan answer. A refusal that is not the law's class is a flag. */
function storedOf(scan: { rule: string; block?: number; detail: string }): string {
  return JSON.stringify({
    verdict: 'flag',
    rule: scan.rule,
    ...(scan.block === undefined ? {} : { block: scan.block }),
    detail: scan.detail,
  });
}

/**
 * Scan the blocks this step wrote. `chapter` is the file that landed; `null` (the first sheet)
 * means there is no delta for B to read — the owner's own words are basis, not a wave's prose.
 */
export function scanStepDelta(
  step: store.StepRow,
  chapter: { blocks: Array<{ hash: string; text: string }> } | null,
): LandingScan {
  if (step.pass === 'front' || chapter === null) {
    return { refusal: null, rule: null, block: null, stored: null };
  }
  const delta = deltaBlocks(step, chapter.blocks);
  // BOOK-DOC-42 §1: the text surface is re-checked against "the same stop list and the same
  // quote rule" — not the unknown-name rule, which asks whether a filing brought a stranger
  // into the book. Here every name is already in the chapter by definition, so the chapter's
  // own blocks are the vocabulary and rule 4 stays inert.
  const scan = scanRights(
    { body: delta.map((block) => block.text).join('\n\n') },
    { knownNames: chapter.blocks.map((block) => block.text) },
  );
  if (scan.verdict === 'clear') {
    return { refusal: null, rule: null, block: null, stored: JSON.stringify({ verdict: 'clear' }) };
  }
  if (scan.verdict === 'refused' && isListRefusal(scan.rule)) {
    // Not releasable: the law's categories and the real-person class. The land is refused with
    // the one sentence the reader is owed and no write at all.
    return {
      refusal: rightsRefusalLine(scan.rule) ?? RIGHTS_COPY.other,
      rule: scan.rule,
      block: scan.block ?? null,
      stored: null,
    };
  }
  return { refusal: null, rule: scan.rule, block: scan.block ?? null, stored: storedOf(scan) };
}

/**
 * B3: give a landed, open step the scan it never had. Idempotent — a step that already carries
 * an answer (clear or flag) is left alone — and it never refuses: the text is published, so a
 * hit makes the gate mandatory instead. A chapter that cannot be read is a flag too: the engine
 * does not know the answer, and "unknown" is not "clear".
 */
export function ensureRightsScan(deps: EngineDeps, step: store.StepRow): store.StepRow {
  if (step.rights_scan !== null || step.landed_at === null) return step;
  if (step.chapter === null || step.pass === 'ending') return step;

  const chapter = readChapter(deps.bookRoot, step.chapter);
  const scan = isWrittenChapter(chapter) ? scanStepDelta(step, chapter) : null;
  // "Unknown" is not "clear": a step whose text cannot be read at close is flagged, not blessed.
  const stored =
    scan?.stored ??
    JSON.stringify({
      verdict: 'flag',
      rule: 'RIGHTS-FLAG',
      detail: scan === null ? 'the chapter could not be read at close' : 'the delta carries no prose to judge',
    });
  store.updateStep(deps.db, step.step_id, { rights_scan: stored });
  return store.getStep(deps.db, step.step_id) ?? step;
}
