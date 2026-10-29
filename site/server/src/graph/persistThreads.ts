/**
 * The threads of one validated answer (BOOK-185, BOOK-DOC-77 §5).
 *
 * A thread is **derived, not temporal**: its id is `thr_` + `sha1(normalised label)[0..20]`, its
 * state and its `closed_at_chapter` are the replay of its events in chapter order, and a thread
 * with no events is not a thread — it is deleted. Nothing here is written «forward only»: the same
 * events always fold to the same state, so a forced re-run of chapter 7 can move a thread back to
 * `complicated` when the new answer says so, and the row still reads the truth of the whole book.
 *
 * The chapter's events are replaced, whatever wrote them: `thread_events` of this chapter for this
 * thread go first, the accepted ones are appended, and the state is recomputed over everything
 * that is left. A thread the answer no longer names but which holds events in this chapter is
 * replayed too — otherwise a retired event would keep its thread open forever.
 *
 * `closed` is final in the machine (`ledger/threads.ts`): the fold stops there, and an event the
 * validator could not have written after it is ignored rather than allowed to reopen a closed
 * line.
 */

import type { Db } from '../db/db.ts';
import type { ThreadState } from '../ledger/threads.ts';
import type { AcceptedThread } from './judged.ts';
import { factIdOf, stampFor, type ExtractionStamp } from './persistFacts.ts';
import { idOf, normalise } from './text.ts';

export type PersistThreadsInput = {
  chapter: number;
  at: string;
  run: ExtractionStamp;
  /** The recall run, when the answer is a merge: a thread it opened carries its stamp. */
  recallRun?: ExtractionStamp;
  threads: readonly AcceptedThread[];
  /** key → id of the facts this answer asserts (a thread event names one). */
  factIds: ReadonlyMap<string, string>;
};

type EventRow = { chapter: number; kind: string };

/** `opened | advanced | complicated | closed`, `closed` final — the machine of `ledger/threads.ts`. */
export function replayThread(events: readonly EventRow[]): {
  state: ThreadState;
  closedAtChapter: number | null;
} {
  let state: ThreadState = 'opened';
  let closedAtChapter: number | null = null;
  for (const event of events) {
    if (state === 'closed') break;
    state = event.kind as ThreadState;
    if (state === 'closed') closedAtChapter = event.chapter;
  }
  return { state, closedAtChapter };
}

/** How many of the answer's threads exist after the write — the run's `threads` count. */
export function persistThreads(db: Db, input: PersistThreadsInput): number {
  const threads = db.prepare('SELECT id, label FROM threads ORDER BY id').all() as Array<{
    id: string;
    label: string;
  }>;
  const idByLabel = new Map(threads.map((row) => [normalise(row.label), row.id]));

  /** Every thread this pass touches: what the answer names, plus what holds events here. */
  const touched = new Map<string, AcceptedThread | null>();
  for (const thread of input.threads) {
    const label = normalise(thread.label);
    const id = idByLabel.get(label) ?? thread.threadId ?? idOf('thr', label);
    touched.set(id, thread);
  }
  const withEvents = db
    .prepare('SELECT DISTINCT thread_id AS id FROM thread_events WHERE chapter = ? ORDER BY thread_id')
    .all(input.chapter) as Array<{ id: string }>;
  for (const row of withEvents) {
    if (!touched.has(row.id)) touched.set(row.id, null);
  }

  const exists = db.prepare('SELECT id FROM threads WHERE id = ?');
  const open = db.prepare(
    `INSERT INTO threads (id, label, direction, opened_at_chapter, closed_at_chapter, state, extracted_by)
     VALUES (?, ?, ?, ?, NULL, 'opened', ?)`,
  );
  const removeEvents = db.prepare('DELETE FROM thread_events WHERE thread_id = ? AND chapter = ?');
  const addEvent = db.prepare(
    `INSERT INTO thread_events (thread_id, chapter, kind, fact_id, note, at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const eventsOf = db.prepare(
    'SELECT chapter, kind FROM thread_events WHERE thread_id = ? ORDER BY chapter, id',
  );
  const update = db.prepare(
    `UPDATE threads
        SET direction = ?, opened_at_chapter = MIN(opened_at_chapter, ?), closed_at_chapter = ?,
            state = ?, extracted_by = ?
      WHERE id = ?`,
  );
  /** A thread the answer no longer names: its state is still the replay, its direction is not ours. */
  const rederive = db.prepare(
    `UPDATE threads
        SET opened_at_chapter = MIN(opened_at_chapter, ?), closed_at_chapter = ?, state = ?
      WHERE id = ?`,
  );
  const dropMentions = db.prepare('DELETE FROM mentions WHERE thread_id = ?');
  const dropThread = db.prepare('DELETE FROM threads WHERE id = ?');
  let written = 0;

  for (const [id, thread] of touched) {
    const stamped = thread === null ? '' : stampFor(input.run, input.recallRun, thread.pass);
    if (thread !== null && exists.get(id) === undefined) {
      // The label is kept from the first spelling: thread mentions are bound by label elsewhere,
      // and a new capitalisation would silently unbind them.
      open.run(id, thread.label.trim(), thread.direction, input.chapter, stamped);
    }
    removeEvents.run(id, input.chapter);
    if (thread !== null) {
      for (const event of thread.events) {
        const factId = input.factIds.get(event.factKey) ?? event.factId ?? factIdOf(event.factKey);
        addEvent.run(id, input.chapter, event.kind, factId, event.note, input.at);
      }
    }
    const events = eventsOf.all(id) as EventRow[];
    if (events.length === 0) {
      // A thread is derived: no events, no thread. Its mentions go with it — a mention of a
      // thread that no longer exists is a dangling reference, not a record.
      dropMentions.run(id);
      dropThread.run(id);
      continue;
    }
    const { state, closedAtChapter } = replayThread(events);
    const first = events[0]?.chapter ?? input.chapter;
    if (thread === null) rederive.run(first, closedAtChapter, state, id);
    else {
      update.run(thread.direction, first, closedAtChapter, state, stamped, id);
      written += 1;
    }
  }
  return written;
}
