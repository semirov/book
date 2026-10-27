/**
 * BOOK-DOC-49 §2 — the first-load sequence: the order, the offsets and the one gate.
 *
 * `t = 0` is the commit where the front lands, never a navigation. While the sequence plays,
 * `<html>` carries `data-front-seq="run"`; every delay in `styles/first-load.css` hangs on
 * that value, so the attribute existing at all is what makes the sequence possible and `done`
 * is its only other state. `run` is written in a layout effect of that commit (before paint)
 * and cleared to `done` by one timer at {@link TOTAL_MS}, at once on the reader's first input
 * and on a `front:updated`; it is never removed, so a later render in the same document
 * inherits the final page instead of an invisible one.
 *
 * The blocks carry `data-seq` ids and this table is the same list as the sheet's delay rules:
 * a drift between the two fails `lib/frontSequence.test.ts` rather than showing up as a block
 * that animates a beat late. `data-seq` is set only for a page load that owns a sequence (§5,
 * §7): under reduced motion, behind a deep link or a restored scroll nothing is tagged at all.
 *
 * BOOK-131 — the table order is the **sequence** order, not the document order. The cover plate
 * is the sheet's last child, but its turn is the byline's 500 ms slot: it is the sheet's second
 * column, not a row after the promise. That is the one stated exception to "the order the
 * document renders", and the 18 ids below are the sequence's, not the DOM's.
 */

/** The gate on `<html>`: `run` while the sequence plays, `done` for the rest of the page load. */
export const GATE_ATTRIBUTE = 'data-front-seq';
export const GATE_RUN = 'run';
export const GATE_DONE = 'done';

/** One block animates for `--dur-ui` (220 ms); the stagger between blocks is 80 ms, uniform. */
export const BLOCK_MS = 220;
export const STAGGER_MS = 80;

/** The caret stays after the last grapheme, greys for 220 ms, then leaves (§3). */
export const TITLE_REST_MS = 220;
/** A renamed title lands whole at 400 ms: the budget is a constant of the sheet, not a word. */
export const TITLE_CAP_MS = 400;
/** The whole budget: the last paragraph starts at 1 700 and ends at 1 920 — 390 and 1440 alike. */
export const TOTAL_MS = 1_920;

/** Page 2 is nine paragraphs; the sequence covers those and leaves any later one alone (§2). */
export const ABOUT_PARAGRAPHS = 9;

/**
 * What a block does when its turn comes. The title is **typed** by `lib/reveal.ts` and gets no
 * fade of its own: an `opacity: 0 → 1` on the `h1` would hide the caret in the very frame that
 * must show an empty title line under it. The rule and the cover plate **fade** only — a rising
 * hairline is invisible, a `scaleX` would draw a line of progress, and an image that performs
 * arriving is fake liveness (§4, BOOK-131).
 */
export type SeqMotion = 'typed' | 'fade' | 'rise';

export type SeqBlock = {
  readonly id: string;
  /** Start of the block's turn, in ms from the data commit. */
  readonly at: number;
  readonly motion: SeqMotion;
};

export const SEQ_BLOCKS: readonly SeqBlock[] = [
  { id: 'title', at: 0, motion: 'typed' },
  // BOOK-131 — the plate takes the byline's turn: the sheet's second column, not a row after
  // the promise. It is the one block whose DOM node is not where this table puts it.
  { id: 'cover', at: 500, motion: 'fade' },
  { id: 'byline', at: 500, motion: 'rise' },
  { id: 'genre', at: 580, motion: 'rise' },
  { id: 'promise', at: 660, motion: 'rise' },
  { id: 'how-1', at: 740, motion: 'rise' },
  { id: 'how-2', at: 820, motion: 'rise' },
  { id: 'how-3', at: 900, motion: 'rise' },
  { id: 'rule', at: 980, motion: 'fade' },
  // Page 2 follows the rule at one stagger each: 1 060, 1 140 … 1 700.
  ...Array.from({ length: ABOUT_PARAGRAPHS }, (_, index): SeqBlock => ({
    id: `about-${index + 1}`,
    at: 1_060 + STAGGER_MS * index,
    motion: 'rise',
  })),
];

/**
 * The ids in the **sequence** order — not the document order: the plate is the sheet's last
 * child while its turn is the byline's (§2, BOOK-131).
 */
export const SEQ_IDS: readonly string[] = SEQ_BLOCKS.map((block) => block.id);

/** The turn of one block, or `null` for an id that is not part of the sequence. */
export function seqAt(id: string): number | null {
  return SEQ_BLOCKS.find((block) => block.id === id)?.at ?? null;
}

export type FrontSequenceInput = {
  /** `location.hash`, read at the commit: an anchor is not the cover (`#ch-12`, `#about`). */
  hash: string;
  /** A restored scroll means the reader did not open on the cover (§2b). */
  scrollY: number;
  reduced: boolean;
  /** The document already reached `done`: a later commit inherits the final state. */
  ran: boolean;
};

/**
 * §2b, §2c, §5 — the sequence is for a page load that opened on the cover, on a machine that
 * did not ask for still paper, and only once per document: nothing is stored, nothing is
 * unlearned, and a gesture any input ends is not a gimmick.
 */
export function shouldRun(input: FrontSequenceInput): boolean {
  if (input.ran || input.reduced) return false;
  if (input.hash !== '') return false;
  return input.scrollY <= 0;
}
