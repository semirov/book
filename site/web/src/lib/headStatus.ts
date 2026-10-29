/**
 * BOOK-156 #3814 — the book's state, in the running head's free space.
 *
 * The head is the one place a reader can look up from the prose without leaving it, and it was
 * the one surface that never said whether a pass runs. The state therefore lives here as a
 * **pure function of the facts the page already holds** — the stage log (`useStages`), the state
 * snapshot's own in-flight marks, and a clock handed in — never as a second store and never as a
 * poll; the single timer that lets a silence *end* lives in `HeadStatus.tsx`, where the line is
 * drawn.
 *
 * Three states, one line each, and the owner's words (2026-10-28) — no «проход», no model id, no
 * second name for a pass:
 *
 *   - **live** — a pass is in flight and its newest fact is younger than `HEAD_SILENCE_MS`:
 *     `книга пишется · глава 12 · 14:21`;
 *   - **stopped** — a pass is in flight but its newest fact is older than 90 s, or the engine is
 *     `down`/`absent`: `книга не пишется · 14:21`. The words are the same verb as the live line —
 *     the reader's sentence about the book, never the machine's. A pass that died is a fact
 *     about now, so the head keeps the line instead of dropping back to silence;
 *   - **idle** — no pass in flight: nothing at all. The foot's grip already says `писалась ·
 *     25.10`, and a second print of the same fact is the chip this head refuses.
 *
 * The clock is handed in (`nowMs`), so the 90 s boundary is a test and not a wait.
 */

import type { EngineStatus, PassStageEvent } from '@book/shared';

import { MIDDOT, formatTime } from './format.ts';
import type { Passes } from './passes.ts';
import type { StagesLog } from './useStages.ts';

/** A pass in flight whose newest fact is older than this is not writing any more. */
export const HEAD_SILENCE_MS = 90_000;

/** The live lead: the book writes itself, in the owner's words (never «проход»). */
export const HEAD_LIVE = 'книга пишется';
/** The stopped lead: the live verb, negated — the book's own sentence, not the engine's. */
export const HEAD_STOPPED = 'книга не пишется';

export type HeadKind = 'live' | 'stopped' | 'idle';

export type HeadStatus = {
  kind: HeadKind;
  /**
   * The line, printed at ≥768; `null` when the head prints nothing. There is no second, shorter
   * variant: the phone prints the page and the book's name, not the state (BOOK-199).
   */
  full: string | null;
  /** The moment the line's time came from, epoch ms — what the silence timer counts from. */
  atMs: number | null;
};

/** The stage log and its in-flight map: `useStages`'s own two facts, and nothing else. */
export type HeadStages = { log: StagesLog; passes: Passes };

/**
 * One in-flight mark. `StateSnapshot.revising` is an array of entries (a mark exists while it
 * lives), and the page's `block:revising` frames are a chapter → mark record; both shapes carry
 * the same three facts, so both are read here rather than a third being invented.
 */
export type HeadRevising = { chapter?: number; since?: string | null; active?: boolean };

export type HeadState = {
  engine: { status: EngineStatus; heartbeatAt: string | null };
  queue?: { processing: { chapter?: number; startedAt?: string | null } | null } | null;
  revising?: readonly HeadRevising[] | Readonly<Record<string, HeadRevising>> | null;
};

export type HeadInput = {
  /** Absent for a caller that holds no log yet (and for `PassRecordPage`): then nothing is live. */
  stages?: HeadStages | null;
  state: HeadState;
  nowMs: number;
};

const parseAt = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** `14:21` in the page's own timezone (Europe/Moscow), or `null` when the moment is unknown. */
const timeOf = (atMs: number | null): string | null =>
  atMs === null ? null : formatTime(new Date(atMs).toISOString());

/** The line's parts joined by the site's non-breaking middot; a missing part prints nothing. */
const lineOf = (parts: ReadonlyArray<string | null>): string =>
  parts.filter((part): part is string => part !== null && part !== '').join(MIDDOT);

const entriesOf = (revising: HeadState['revising']): HeadRevising[] => {
  if (revising === null || revising === undefined) return [];
  const list = Array.isArray(revising) ? revising : Object.values(revising);
  // A caller that hands the frame record over keeps its `active` flag: an explicit `false` is
  // not a mark, everything else is (a snapshot's entry exists exactly while the mark lives).
  return list.filter((entry) => entry.active !== false);
};

/**
 * The newest stage among the chapters that hold a pass in flight, with its chapter. The log
 * remembers finished chapters too, so a global "latest event" would report a pass that is over;
 * only the in-flight chapters are read.
 */
function inFlightOfLog(stages: HeadStages | null | undefined): { chapter: number; atMs: number | null } | null {
  if (stages === null || stages === undefined) return null;
  let first: number | null = null;
  let newest: PassStageEvent | null = null;
  for (const key of Object.keys(stages.passes)) {
    const chapter = Number(key);
    if (!Number.isInteger(chapter) || chapter < 1) continue;
    if (first === null) first = chapter;
    for (const event of stages.log[chapter] ?? []) {
      const later =
        newest === null ||
        event.at > newest.at ||
        (event.at === newest.at && event.stageSeq > newest.stageSeq);
      if (later) newest = event;
    }
  }
  if (first === null) return null;
  // A chapter in flight whose stages the page never saw: the pass is real, its clock is not —
  // the snapshot's own moments stand in below.
  return { chapter: newest?.chapter ?? first, atMs: newest?.at ?? null };
}

/**
 * The head's state and its one line. The fact that a pass is in flight comes from the log's own
 * fold first (the stage frames the page saw), then from the snapshot — a change the queue is
 * processing, then a block carrying the revision mark — so a page that missed the frames still
 * says the book is being written.
 */
export function headStatusOf({ stages, state, nowMs }: HeadInput): HeadStatus {
  let chapter: number | null = null;
  let atMs: number | null = null;

  const pass = inFlightOfLog(stages);
  const processing = state.queue?.processing ?? null;
  const revising = entriesOf(state.revising);
  if (pass !== null) {
    chapter = pass.chapter;
    atMs = pass.atMs;
  } else if (processing !== null) {
    chapter = processing.chapter ?? null;
    atMs = parseAt(processing.startedAt);
  } else {
    const [first] = revising;
    if (first === undefined) return { kind: 'idle', full: null, atMs: null };
    chapter = first.chapter ?? null;
    atMs = parseAt(first.since);
  }

  // A stage's own moment is the fact the page saw; the engine's heartbeat is what is left when a
  // snapshot says «working» with no stage behind it.
  const anchor = atMs ?? parseAt(state.engine.heartbeatAt);
  const gone = state.engine.status === 'down' || state.engine.status === 'absent';
  const silent = anchor !== null && nowMs - anchor > HEAD_SILENCE_MS;
  const time = timeOf(anchor);

  if (gone || silent) {
    return {
      kind: 'stopped',
      // The clock is the detail that fits: the fact is the words, and a known moment rides
      // after them; an unknown one is omitted, never printed as a placeholder.
      full: lineOf([HEAD_STOPPED, time]),
      atMs: anchor,
    };
  }

  return {
    kind: 'live',
    full: lineOf([HEAD_LIVE, chapter === null ? null : `глава ${chapter}`, time]),
    atMs: anchor,
  };
}
