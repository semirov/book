/**
 * Story lines (BOOK-176, BOOK-DOC-69): a thread is opened somewhere, moves, may complicate and
 * closes. The states are the ledger's vocabulary, and the moves between them are the state
 * machine — `closed` is final, and a chapter that tries to advance a closed thread is refused
 * rather than recorded, because a thread that reopens makes «what was still open at chapter 20?»
 * unanswerable.
 *
 * Every move is also an event, so the thread's own history is readable without replaying the
 * states: `threads.state` is the current answer, `thread_events` is how it got there.
 */

import type { Db } from '../db/db.ts';
import { ulid } from '../util/ulid.ts';
import { toIso } from '../util/time.ts';

export type ThreadDirection = 'forward' | 'backward';
export type ThreadState = 'opened' | 'advanced' | 'complicated' | 'closed';
export type ThreadMove = 'advanced' | 'complicated' | 'closed';

export type ThreadRow = {
  id: string;
  label: string;
  direction: ThreadDirection;
  opened_at_chapter: number;
  closed_at_chapter: number | null;
  state: ThreadState;
};

/** A move the state machine does not allow. The caller's `code` is what an operator sees. */
export class ThreadTransitionError extends Error {
  readonly code = 'THREAD_TRANSITION';
  constructor(
    readonly threadId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`thread ${threadId}: ${from} → ${to} is not a transition`);
    this.name = 'ThreadTransitionError';
  }
}

/** The legal moves. `closed` has none: a closed thread stays closed. */
const ALLOWED: Record<ThreadState, readonly ThreadMove[]> = {
  opened: ['advanced', 'complicated', 'closed'],
  advanced: ['advanced', 'complicated', 'closed'],
  complicated: ['advanced', 'closed'],
  closed: [],
};

export type OpenThreadInput = {
  label: string;
  direction: ThreadDirection;
  chapter: number;
  id?: string;
  /** The fact that states the thread, when the opening is itself a statement. */
  factId?: string | null;
  note?: string | null;
  at?: string;
};

/** Open a thread: state `opened` and the event that says so, in one act. */
export function openThread(db: Db, input: OpenThreadInput): string {
  const id = input.id ?? `thr_${ulid()}`;
  const at = input.at ?? toIso(Date.now());
  db.transaction(() => {
    db.prepare(
      `INSERT INTO threads (id, label, direction, opened_at_chapter, closed_at_chapter, state)
       VALUES (?, ?, ?, ?, NULL, 'opened')`,
    ).run(id, input.label, input.direction, input.chapter);
    db.prepare(
      `INSERT INTO thread_events (thread_id, chapter, kind, fact_id, note, at)
       VALUES (?, ?, 'opened', ?, ?, ?)`,
    ).run(id, input.chapter, input.factId ?? null, input.note ?? null, at);
  })();
  return id;
}

export type AdvanceThreadInput = {
  threadId: string;
  chapter: number;
  kind: ThreadMove;
  factId?: string | null;
  note?: string | null;
  at?: string;
};

/**
 * Move a thread. Throws `ThreadTransitionError` for a move the machine does not allow — the
 * row and the event are written together or not at all.
 */
export function advanceThread(db: Db, input: AdvanceThreadInput): ThreadState {
  const at = input.at ?? toIso(Date.now());
  return db.transaction((): ThreadState => {
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(input.threadId) as
      | ThreadRow
      | undefined;
    if (thread === undefined) throw new ThreadTransitionError(input.threadId, 'missing', input.kind);
    if (!ALLOWED[thread.state].includes(input.kind)) {
      throw new ThreadTransitionError(input.threadId, thread.state, input.kind);
    }
    db.prepare(
      `UPDATE threads SET state = ?, closed_at_chapter = CASE WHEN ? = 'closed' THEN ? ELSE closed_at_chapter END
        WHERE id = ?`,
    ).run(input.kind, input.kind, input.chapter, input.threadId);
    db.prepare(
      `INSERT INTO thread_events (thread_id, chapter, kind, fact_id, note, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.threadId, input.chapter, input.kind, input.factId ?? null, input.note ?? null, at);
    return input.kind;
  })();
}

export function getThread(db: Db, id: string): ThreadRow | undefined {
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
}
