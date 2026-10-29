import type { ParagraphChainDto, ParagraphVersionDto } from '@book/shared';

import { formatTime } from './format.ts';
import {
  BASIS_HAND,
  FRAME_HAND,
  PASS_HAND,
  UNATTRIBUTED_HAND,
} from './provenance.ts';

/**
 * BOOK-128 (designer, 2026-10-28, comment #3815) — «откуда эта фраза» is the same marginalia
 * as «откуда это слово», one level up: the phrase's own three facts, in the same register,
 * beside the line it speaks about. The chain panel's box, its close, its `«…» · глава N`
 * header, its `ver` rows and its `blockId` codes are gone with the panel.
 *
 * The three facts of a phrase:
 *   1. the hand of its last version — `машина`, a reader's name or their change; the frame
 *      and the basis are hands without a moment, and a version no actor claims is
 *      `правка вне процесса`;
 *   2. whether it can still change — `меняется` / `не меняется` (the frame, the basis, or a
 *      paragraph the log says was removed);
 *   3. its trail — the change that last landed on it (`правка №12 · внесена 12:40`), or
 *      `правок не было` when only the introduction exists.
 *
 * No number here is invented: the number is the log's own change sequence, printed unpadded
 * (`№12`, never `012`), and a filing is named by that same change number — the schema has no
 * filing sequence of its own (`lib/filings.ts`).
 */

/** The paragraph's frame mark, as the phrase layer needs it: the two frozen surfaces, or none. */
export type SentenceFrame = 'frame' | 'basis' | 'none';

/**
 * Which frozen surface the phrase sits on. `basis` wins over `touched`: page 2 *is* the basis
 * sentence, and a tap inside it may never relabel the book's foundation as its frame.
 */
export function sentenceBlockFrame(input: { basis: boolean; touched: boolean }): SentenceFrame {
  if (input.basis) return 'basis';
  return input.touched ? 'frame' : 'none';
}

export type SentenceFacts = {
  /** Line 1 — the hand, with the moment of its last version when there is one. */
  hand: string;
  /** Line 2 — `меняется` / `не меняется`. */
  mutable: string;
  /** Line 3 — the change that landed, or the fact that none did. */
  trail: string;
};

export const SENTENCE_LABEL = 'фраза';
export const MUTABLE = 'меняется';
export const FIXED = 'не меняется';
export const NO_REWRITES = 'правок не было';

function handOf(last: ParagraphVersionDto | null, frame: SentenceFrame): string {
  if (frame === 'basis') return BASIS_HAND;
  if (frame === 'frame') return FRAME_HAND;
  if (last === null) return PASS_HAND;
  // A reader's filing produced this version: the record's own change number stands in for the
  // hand — unpadded, exactly as the owner reads it (`правка · №12`).
  if (last.actor?.kind === 'reader') {
    if (last.changeSeq !== null) return `правка · №${last.changeSeq}`;
    // A reader's version the log numbers with no change: their own label is the hand, and the
    // pass that printed the paragraph must not take it (`provenance.ts` `handOf` says the same).
    return last.actor.label;
  }
  // Nothing claims it: no actor and no change behind it.
  if (last.actor === null && last.changeSeq === null) return UNATTRIBUTED_HAND;
  // The machine's act is the hand alone; the moment it wrote is the trail's own fact, and
  // printing it here would be a second telling of the same history.
  return PASS_HAND;
}

/**
 * The three facts of one phrase. The chain may be `null` (a 404 is an answer): the hand is then
 * the pass that wrote the chapter, and the trail says no change was recorded.
 */
export function sentenceFacts(input: { chain: ParagraphChainDto | null; frame: SentenceFrame }): SentenceFacts {
  const { chain, frame } = input;
  const last = chain?.versions.at(-1) ?? null;
  const fixed = frame !== 'none' || chain?.alive === false;
  return {
    hand: handOf(last, frame),
    mutable: fixed ? FIXED : MUTABLE,
    trail:
      last !== null && last.changeSeq !== null
        ? `правка №${last.changeSeq} · внесена ${formatTime(last.at)}`
        : NO_REWRITES,
  };
}
