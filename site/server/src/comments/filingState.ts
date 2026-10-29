/**
 * One filing's state, derived from the **changes** it became (BOOK-7, BOOK-136).
 *
 * A comment row's `status` stops at triage: `accepted` means «the reader's filing is in», and
 * nothing on the row moves when the writer picks the change up, lands it or refuses it. The
 * change is the only record of what became of the text, so `toCommentDto` never copies the
 * row's word for a filing a change holds.
 *
 * A filing can have **several** changes — an escalated attempt, then another that landed — and
 * `comments.change_id` is only one of them (the live rows point at the escalated attempt). The
 * state therefore reads the whole set the ledger keeps under `changes.source_comment`, and the
 * landing, wherever it stands in that order, is the last word.
 *
 * BOOK-174 moved the pure words (a premise's landing, a failed attempt, the gate's refusal) to
 * `states.ts`; this module is what only storage can answer — which of a filing's changes counts
 * — plus the two facts that follow from it: the public `status` of an ordinary filing, and
 * `changeStatus` (`pending`/`processing` while the filing is the writer's business, `null` once
 * it is not, so the page can tell «ждёт» from «идёт» without inventing a queue).
 */

import type { CommentStatus, FilingState } from '@book/shared';

import type { Db } from '../db/db.ts';
import { decided, isStopped, OWN_STATES, STOPPED_STATUS } from './states.ts';

/** One change of a filing, as this module reads it: the columns a state is chosen from. */
export type FilingChange = {
  id: string;
  seq: number;
  premise: number;
  status: string;
  outcome: string | null;
  reason: string | null;
  /** BOOK-136 — the chapter the change targets; the receipt of a landing names it. */
  chapter: number;
};

const CHANGE_COLUMNS = 'id, seq, premise, status, outcome, reason, chapter';

/** The columns of a change, by its id — for a `change_id` no `source_comment` row answers. */
function byId(db: Db, changeId: string): FilingChange | undefined {
  return db.prepare(`SELECT ${CHANGE_COLUMNS} FROM changes WHERE id = ?`).get(changeId) as
    | FilingChange
    | undefined;
}

/** BOOK-136 — the outcomes a `done` change is closed with when the text took it. */
const LANDED_OUTCOMES = new Set(['applied', 'adapted', 'finding']);

/**
 * Did this change land the reader's text? `done` alone is not a landing (`registered`).
 *
 * BOOK-219 — exported because the site's bridge must speak a landing to the filing (`comment:
 * decision`) with the **same** rule this module uses to derive the filing's state; a second
 * copy of the set would let the frame and the row disagree the day one of them moves.
 */
export function isLanding(change: Pick<FilingChange, 'status' | 'outcome'>): boolean {
  return change.status === 'done' && change.outcome !== null && LANDED_OUTCOMES.has(change.outcome);
}

export type FilingChanges = {
  /** The newest change that landed the reader's text — the receipt and the last word. */
  landed: FilingChange | undefined;
  /**
   * The filing's current attempt: the newest row the ledger holds for it, else the row
   * `change_id` names. An older attempt is history, whatever `comments.change_id` says.
   */
  attempt: FilingChange | undefined;
};

/**
 * BOOK-136 — every change a filing became, resolved once.
 *
 * The owner's live rows: `comments.change_id` names an `escalated · gate_timeout` attempt while
 * a later `done · applied` change landed the same text, so a DTO that read only the linked row
 * kept saying «идёт · правка в очереди на запись» over a chapter already written. Resolution:
 *
 *   1. the **landing** is the newest `done` change whose outcome took the text
 *      (`applied`/`adapted`/`finding`), wherever it sits among the filing's changes;
 *   2. the **attempt** is the newest change the ledger recorded for this filing, or the linked
 *      row when the ledger has none (older data, a hand-made link);
 *   3. `comments.change_id` never outranks a newer attempt, and never outranks a landing.
 */
export function filingChanges(db: Db, commentId: string, changeId: string | null): FilingChanges {
  const rows = db
    .prepare(`SELECT ${CHANGE_COLUMNS} FROM changes WHERE source_comment = ? ORDER BY seq DESC`)
    .all(commentId) as FilingChange[];
  const newest = rows[0];
  const linked =
    changeId === null ? undefined : (rows.find((row) => row.id === changeId) ?? byId(db, changeId));
  const landed = rows.find(isLanding) ?? (linked !== undefined && isLanding(linked) ? linked : undefined);
  const attempt =
    newest !== undefined && (linked === undefined || newest.seq >= linked.seq) ? newest : linked;
  return { landed, attempt };
}

/**
 * BOOK-136/BOOK-206 B2 — the change a filing's state is read from.
 *
 * The landing is the last word about text — except when the filing's **current** attempt is a
 * stop that came after it: a pass the engine gave up on is the newest fact, and an earlier
 * landing is not what became of the filing that was tried again. A landing newer than the stop is
 * still the answer, so both directions read the same rule: the newest fact wins.
 */
export function decisiveChange(facts: FilingChanges): FilingChange | undefined {
  const { landed, attempt } = facts;
  if (attempt !== undefined && isStopped(attempt.status) && (landed === undefined || attempt.seq >= landed.seq)) {
    return attempt;
  }
  return landed ?? attempt;
}

/**
 * BOOK-136 — an ordinary filing's public state, from the change that decided it.
 *
 * The owner's prod rows: the change was `done applied` and the comment stayed `accepted`, so
 * the thread printed «идёт · правка в очереди на запись» about text that was already written,
 * beside a writer that had nothing to do. The row's word is where the filing stands before the
 * lane touches it, never after:
 *
 *   1. a row that decided itself keeps its own word;
 *   2. `done` + a landing outcome is `applied`; `done` + `registered` is the paperwork row;
 *   3. `void` + a **human sentence** is a decision: a supersede, or the writer's refusal;
 *   4. a change the engine **stopped** (`escalated`/`failed`) is one terminal state, whatever
 *      its outcome: the text was not written (or was put back before the stop), and nothing
 *      will retry the filing. BOOK-206 B2 — the word and the sentence come from here, so the
 *      card, the record and the change card cannot answer three ways about one stop;
 *   5. everything else — `pending`, `processing`, `stale`, a `void` with an internal code (a
 *      failed attempt) — has not decided, so the filing keeps its own word;
 *   6. no linked change at all: the row's word is the whole record.
 */
export function filingStatus(change: FilingChange | undefined, fallback: CommentStatus): CommentStatus {
  if (OWN_STATES.has(fallback) || change === undefined) return fallback;
  if (change.status === 'done') {
    if (change.outcome === 'registered') return 'registered';
    if (isLanding(change)) return 'applied';
    return fallback;
  }
  if (change.status === 'void' && decided(change.reason)) {
    return change.outcome === 'superseded' ? 'superseded' : 'rejected';
  }
  // BOOK-206 B2: a stopped change is a terminal state, never a queue place. Its reason is the
  // change's own public line (`states.ts` `stoppedLine`), read by every surface that prints it.
  if (isStopped(change.status)) return STOPPED_STATUS;
  return fallback;
}

/**
 * BOOK-136 — the one fact `status` cannot carry: the writer has the filing in hand or the lane
 * holds it. Only a live change has it; a landed, refused or failed one is not in anyone's queue.
 */
export function linkedChangeStatus(change: FilingChange | undefined): 'pending' | 'processing' | null {
  if (change === undefined) return null;
  if (change.status === 'pending') return 'pending';
  if (change.status === 'processing') return 'processing';
  return null;
}

/**
 * BOOK-DOC-84 #17 — the storage word of a filing, as the frame's own vocabulary. The reader's
 * line prints one of seven words; a `batched`/`delivered` row is still `new` (the lane has not
 * decided it), and `superseded` is a refusal like `rejected` (another premise took the place).
 * One mapping, because the live block and `filing:update` must never disagree about a row.
 */
export function filingStateOf(status: string): FilingState {
  switch (status) {
    case 'accepted':
    case 'applied':
      return 'accepted';
    case 'registered':
      return 'registered';
    case 'rejected':
    case 'superseded':
      return 'refused';
    case 'quarantined':
      return 'quarantined';
    case 'expired':
    case 'hidden':
      return 'expired';
    default:
      // `new`, `batched`, `delivered`, `escalated` and every pre-v16 word: still waiting.
      return 'new';
  }
}
