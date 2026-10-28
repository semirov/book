/**
 * The frozen frame seen from a filing (BOOK-137, F029, BOOK-DOC-4).
 *
 * The two canon sentences are the one piece of text the owner fixed: ch01 opens with them,
 * ch42 closes with them (`book.ts`). A reader may file an intervention anywhere, including on
 * those words — but an accepted filing that **touches** the sentence becomes paperwork, never
 * text: the change is recorded with this mark and a paperwork mode, and the letters stay.
 *
 * One classifier, one warning line, one reason line: the site, the thread and the change card
 * read these and never keep a copy. Pure — no I/O, no knowledge of the database.
 */

import { frameSentenceOf } from './book.ts';
import type { RetroMode } from './change.ts';

/**
 * How a filing sits against the frame of its chapter.
 *
 * `touched` — the filing intersects the sentence itself (an acceptance of it is paperwork);
 * `adjacent` — the filing is in the sentence's own paragraph, or in the one beside it inside
 * the chapter, but not on the sentence (an ordinary edit, told apart from a far one in the
 * record); `untouched` — anywhere else, and every chapter without a frame.
 */
export type FrameMark = 'touched' | 'adjacent' | 'untouched';

export const FRAME_MARKS = ['touched', 'adjacent', 'untouched'] as const;

/**
 * The strip's one line, printed when a selection intersects the canon sentence and **before**
 * the reader types: trying is allowed, and lying about the outcome is not. The web reads this
 * constant; it never restates the sentence.
 */
export const FRAME_WARNING = 'это рамка книги: правка будет рассмотрена, фраза не изменится';

/** The paperwork mode a touched filing is filed as unless the caller named one. */
export const DEFAULT_FRAME_MODE: RetroMode = 'оформление';

/** A stored mark this build knows; `null` for an empty column or an unknown word. */
export function normalizeFrameMark(raw: unknown): FrameMark | null {
  return typeof raw === 'string' && (FRAME_MARKS as readonly string[]).includes(raw)
    ? (raw as FrameMark)
    : null;
}

/**
 * The public one-liner a touched filing ends with — on the change and on the comment, the same
 * words once (≤200 chars). The mode is the retroactive cause it was filed as, never a verdict.
 */
export function framePaperworkReason(mode: RetroMode): string {
  return `принято как ${mode}: рамка книги — фраза не меняется`;
}

export type FrameInput = {
  chapter: number;
  /** The reader's quote, or null for a chapter-level filing. */
  quote: string | null;
  /** Index of the anchored block at posting time; null for a chapter-level filing. */
  blockIndex: number | null;
  /** The anchored block's text, when the anchor resolved to one. */
  blockText: string | null;
  /** Paragraphs the chapter had when the filing was made. */
  blockCount: number;
};

/** Whitespace is not text: a rewrapped line and the canon sentence compare as one string. */
function flat(value: string | null): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

export function classifyFrame(input: FrameInput): FrameMark {
  const frame = frameSentenceOf(input.chapter);
  // A chapter without a frame sentence has nothing a filing could touch.
  if (frame === null) return 'untouched';

  const expected = flat(frame);
  const quote = flat(input.quote);
  if (quote.length > 0 && (quote.includes(expected) || expected.includes(quote))) return 'touched';

  // `adjacent` is about where the filing sat, not what it proposed: the frame's own paragraph,
  // or the block beside the frame's inside the chapter — the paragraph after ch01's sentence,
  // the paragraph before ch42's. A filing 50 blocks away is `untouched`, and the record can
  // tell the two apart.
  if (flat(input.blockText).includes(expected)) return 'adjacent';
  if (input.blockIndex === null) return 'untouched';
  return frameBlocksOf(input.chapter, input.blockCount).includes(input.blockIndex) ? 'adjacent' : 'untouched';
}

/**
 * The frame's paragraph and the one beside it, inside the chapter. A written chapter opens
 * (ch01) or closes (ch42) on the frame, so its own block is the first or the last one and the
 * neighbour is the block after it or before it — index 1 and `last - 1`. The frame's own block
 * is already recognised by `blockText` above; naming it here costs nothing and keeps the rule
 * readable as stated, so a chapter that ever holds the frame elsewhere needs no second rule.
 */
function frameBlocksOf(chapter: number, blockCount: number): readonly number[] {
  const last = Math.max(0, blockCount - 1);
  return chapter === 1 ? [0, 1] : [last - 1, last];
}
