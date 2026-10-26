/**
 * A reader's own decisions (ARCHITECTURE.md §9, §11.6; BOOK-DOC-4 rule 4, BOOK-13).
 *
 * The end of an intervention is a fact the reader is owed: what was done with it, where the
 * consequence reached, how many waves it ran, how much text is still theirs. The frame that
 * announces a decision is a **broadcast** — every open page sees it — so it can never be the
 * reader's own record. This type is that record: own only, durable, and reachable again
 * long after the frame has been forgotten.
 *
 * Two shapes of the same fact live here. `GET /api/me/decisions` answers the durable one
 * (`MyDecisionsDto`), and the client matches a live `change:decided`/`comment:decision`
 * frame against `open` — the ids of the viewer's own comments that are not decided yet —
 * so a frame about somebody else can never render as «ваша правка». No identity key is in
 * either shape: the comment ids are already public objects of the thread.
 */

/** The endpoint's bound: the newest 20 decisions of one reader, never a history dump. */
export const MY_DECISIONS_LIMIT = 20;

/** How many own undecided comments the client is told about, as its key to a live frame. */
export const MY_OPEN_LIMIT = 10;

/**
 * The vocabulary a reader is shown. It carries no status code and no gate role:
 * `refused` is the guard, triage and auditor refusal told as one public fact, and
 * `escalated` means the consequence stopped and waits for the author's decision.
 */
export type MyDecisionOutcome =
  | 'applied'
  | 'adapted'
  | 'queued'
  | 'escalated'
  | 'dropped'
  | 'superseded'
  | 'failed'
  | 'refused';

/**
 * A share exactly as it was measured, with the day it was measured on. The day travels
 * because a daily measurement may be older than the fact it is shown beside: «на 20.10
 * было 0,3 %» is true, «на момент правки 0,3 %» would not be.
 */
export type MeasuredShareDto = { share: number; day: string };

/**
 * One intervention of the viewer, as it ended.
 *
 * The numbers are present only when a ripple actually ran (`applied`/`adapted`): a refusal,
 * a stop, a wait or a plain rejection has no waves, no chapters and no blocks, and a share
 * is never invented for one. For the same reason `intent` — the change's own public
 * sentence, the closest thing to «what plot turn it brought» that the system measures — is
 * set only for those two outcomes, where a change exists *and* had an effect; it is quoted
 * on the page as the author's words, never as site copy.
 */
export type MyDecisionDto = {
  /** The viewer's own comment: the key the client matches a live frame against. */
  commentId: string;
  changeId: string | null;
  /** The chapter the viewer intervened in. */
  chapter: number;
  /** ≤280 chars, the change's own public intent; only for `applied`/`adapted`. */
  intent: string | null;
  outcome: MyDecisionOutcome;
  /** The public one-liner of a refusal or a stop; never a taxonomy, never a role. */
  reason: string | null;
  /** Chapters the ripple touched, ascending; empty when nothing ran. */
  chapters: number[];
  /** Waves the ripple ran; null when no ripple ran. */
  waves: number | null;
  /** Paragraphs the ripple changed; null when no ripple ran. */
  blocks: number | null;
  /**
   * The viewer's share as last measured at or before the decision — floored, and carrying
   * the day of that measurement; null when the measurement never covered that time.
   */
  shareAtDecision: MeasuredShareDto | null;
  decidedAt: string;
};

/** The reader's own record (`GET /api/me/decisions`), newest first. */
export type MyDecisionsDto = {
  items: MyDecisionDto[];
  /**
   * The viewer's own comments that are not decided yet — the client's key to its own live
   * frame. An id here is not a permission: it only tells the page «this one is yours».
   */
  open: string[];
  /** The viewer's surviving share now, floored exactly as `/api/authors/me` prints it. */
  share: number;
};
