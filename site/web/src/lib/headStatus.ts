/**
 * BOOK-207 — the book's state in the running head's free space, in the book's own voice.
 *
 * The head is the one place a reader can look up from the prose without leaving it. What it
 * says is one word about now and nothing else: `сейчас пишется` while a pass is in flight and
 * its newest fact is younger than `HEAD_SILENCE_MS`, `сейчас тихо` when the pass is still open
 * but silent past that bound (or the engine is `down`/`absent`), and nothing at all when no
 * pass runs. No chapter, no clock, no stage, no counter and no vendor: the previous line
 * (`книга пишется · глава 12 · 14:21`) was a dashboard in a book's head, and BOOK-207 retires
 * it whole, together with the functions that could rejoin its parts.
 *
 * The state is a **pure function of the facts the page already holds** — the stage log
 * (`useStages`), the state snapshot's own in-flight marks, and a clock handed in — never a
 * second store and never a poll; the single timer that lets a silence *end* lives in
 * `HeadStatus.tsx`, where the line is drawn.
 *
 * The clock is handed in (`nowMs`), so the 90 s boundary is a test and not a wait.
 */

import type { EngineStatus, PassStageEvent } from '@book/shared';

import type { Passes } from './passes.ts';
import type { StagesLog } from './useStages.ts';

/** A pass in flight whose newest fact is older than this is not writing any more. */
export const HEAD_SILENCE_MS = 90_000;

/** The live word: the book writes itself, in the owner's words (never «проход»). */
export const HEAD_LIVE = 'сейчас пишется';
/** The quiet word: a pass is open but has said nothing for 90 s, or the engine is gone. */
export const HEAD_STOPPED = 'сейчас тихо';

export type HeadKind = 'live' | 'stopped' | 'idle';

export type HeadStatus = {
  kind: HeadKind;
  /** The one word, or `null` when the head prints nothing. */
  full: string | null;
  /** The moment the silence counts from, epoch ms — what the head's one timer reads. */
  atMs: number | null;
};

/** The stage log and its in-flight map: `useStages`'s own two facts, and nothing else. */
export type HeadStages = { log: StagesLog; passes: Passes };

/**
 * One in-flight mark. `StateSnapshot.revising` is an array of entries (a mark exists while it
 * lives), and the page's `block:revising` frames are a chapter → mark record; both shapes carry
 * the same facts, so both are read here rather than a third being invented.
 */
export type HeadRevising = { chapter?: number; since?: string | null; active?: boolean };

export type HeadState = {
  engine: { status: EngineStatus; heartbeatAt: string | null };
  queue?: { processing: { chapter?: number; startedAt?: string | null } | null } | null;
  revising?: readonly HeadRevising[] | Readonly<Record<string, HeadRevising>> | null;
};

export type HeadInput = {
  /** Absent for a caller that holds no log yet: then nothing is live. */
  stages?: HeadStages | null;
  state: HeadState;
  nowMs: number;
};

const parseAt = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const entriesOf = (revising: HeadState['revising']): HeadRevising[] => {
  if (revising === null || revising === undefined) return [];
  const list = Array.isArray(revising) ? revising : Object.values(revising);
  // A caller that hands the frame record over keeps its `active` flag: an explicit `false` is
  // not a mark, everything else is (a snapshot's entry exists exactly while the mark lives).
  return list.filter((entry) => entry.active !== false);
};

/**
 * The newest stage among the chapters that hold a pass in flight. The log remembers finished
 * chapters too, so a global "latest event" would report a pass that is over; only the
 * in-flight chapters are read.
 */
function newestInFlight(stages: HeadStages | null | undefined): { present: boolean; atMs: number | null } {
  if (stages === null || stages === undefined) return { present: false, atMs: null };
  let present = false;
  let newest: PassStageEvent | null = null;
  for (const key of Object.keys(stages.passes)) {
    const chapter = Number(key);
    if (!Number.isInteger(chapter) || chapter < 1) continue;
    present = true;
    for (const event of stages.log[chapter] ?? []) {
      const later =
        newest === null ||
        event.at > newest.at ||
        (event.at === newest.at && event.stageSeq > newest.stageSeq);
      if (later) newest = event;
    }
  }
  // A chapter in flight whose stages the page never saw: the pass is real, its clock is not —
  // the snapshot's own moments stand in below.
  return { present, atMs: newest?.at ?? null };
}

/**
 * The head's state and its one word. The fact that a pass is in flight comes from the log's own
 * fold first (the stage frames the page saw), then from the snapshot — a change the queue is
 * processing, then a block carrying the revision mark — so a page that missed the frames still
 * says the book is being written.
 */
export function headStatusOf({ stages, state, nowMs }: HeadInput): HeadStatus {
  let atMs: number | null = null;

  const pass = newestInFlight(stages);
  const processing = state.queue?.processing ?? null;
  const revising = entriesOf(state.revising);
  if (pass.present) {
    atMs = pass.atMs;
  } else if (processing !== null) {
    atMs = parseAt(processing.startedAt);
  } else {
    const [first] = revising;
    if (first === undefined) return { kind: 'idle', full: null, atMs: null };
    atMs = parseAt(first.since);
  }

  // A stage's own moment is the fact the page saw; the engine's heartbeat is what is left when a
  // snapshot says «working» with no stage behind it.
  const anchor = atMs ?? parseAt(state.engine.heartbeatAt);
  const gone = state.engine.status === 'down' || state.engine.status === 'absent';
  const silent = anchor !== null && nowMs - anchor > HEAD_SILENCE_MS;

  if (gone || silent) return { kind: 'stopped', full: HEAD_STOPPED, atMs: anchor };
  return { kind: 'live', full: HEAD_LIVE, atMs: anchor };
}
