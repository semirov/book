/**
 * BOOK-207 / BOOK-218 — the book's state in the running head's free space, in the book's voice.
 *
 * The head is the one place a reader can look up from the prose without leaving it. What it says
 * is **one short word about now** and nothing else (owner, 2026-10-29): `тихо` when nothing is in
 * flight, `правку читают` while a filing is being read, `правка ждёт` while a change stands in
 * line, `главу пишут` while the chapter is being drafted, `главу проверяют` while the gates read
 * it, `внесено` just after a landing, and `связи нет` when the page has no live line. No chapter,
 * no clock, no stage, no counter and no vendor: the words are `HEAD_WORDS` in `@book/shared`'s
 * `stateWords.ts` and nowhere else.
 *
 * The state is a **pure function of the facts the page already holds** — the stage log
 * (`useStages`), the state snapshot's own in-flight marks, the socket's status and a clock handed
 * in — never a second store and never a poll; the single timer that lets a silence *end* lives in
 * `HeadStatus.tsx`, where the line is drawn.
 *
 * The clock is handed in (`nowMs`), so the 90 s boundary is a test and not a wait.
 */

import { draftingLine, FILING_LINES, HEAD_WORDS, type PassStage } from '@book/shared';

import { formatTime } from './format.ts';
import type { Passes } from './passes.ts';
import type { StagesLog } from './useStages.ts';

/** A pass in flight whose newest fact is older than this is not writing any more. */
export const HEAD_SILENCE_MS = 90_000;

/** The line's kind: one of the seven words, each drawn with its own ink. */
export type HeadKind = 'idle' | 'reading' | 'waiting' | 'drafting' | 'gates' | 'landed' | 'offline';

export type HeadStatus = {
  kind: HeadKind;
  /** The one word. */
  full: string;
  /**
   * The moment the silence counts from, epoch ms — what the head's one timer reads. `null` for a
   * kind that has no silence to end.
   */
  atMs: number | null;
  /**
   * The longer sentence the word stands for, shown when a reader asks (the line's `title`): what
   * is being written and from when, or why the page cannot say. `null` when the word says it all.
   */
  detail: string | null;
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
  engine: { status: string; heartbeatAt: string | null };
  queue?: {
    processing: { chapter?: number; startedAt?: string | null } | null;
    /** The change the lane picks next, and how many stand in line (`StateSnapshot.queue`). */
    head?: { chapter?: number } | null;
    depth?: number;
  } | null;
  revising?: readonly HeadRevising[] | Readonly<Record<string, HeadRevising>> | null;
};

/** The socket's own status (`lib/ws.ts`): absent means the caller holds no line and claims none. */
export type HeadSocket = 'connecting' | 'open' | 'closed' | 'capacity';

export type HeadInput = {
  /** Absent for a caller that holds no log yet: then no pass is live. */
  stages?: HeadStages | null;
  state: HeadState;
  /** The page's `BookSocket` status; a caller that holds none says nothing about the line. */
  socket?: HeadSocket | null;
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
 * The word a pass's stage answers to. `landed` and `refused` end a pass and the in-flight fold
 * never keeps them; a stage the page does not know reads as the chapter being written.
 */
function kindOfStage(stage: PassStage): HeadKind {
  if (stage === 'queued') return 'waiting';
  if (stage === 'read') return 'reading';
  if (stage === 'verdict') return 'gates';
  return 'drafting';
}

/**
 * The newest fact among the chapters that hold a pass in flight, what the pass is doing, and the
 * moment its first stage was seen. The log remembers finished chapters too, so a global "latest
 * event" would report a pass that is over; only the in-flight chapters are read.
 */
function inFlight(stages: HeadStages | null | undefined): {
  present: boolean;
  atMs: number | null;
  kind: HeadKind | null;
  startedAt: number | null;
} {
  if (stages === null || stages === undefined) {
    return { present: false, atMs: null, kind: null, startedAt: null };
  }
  let present = false;
  let atMs: number | null = null;
  let kind: HeadKind | null = null;
  let startedAt: number | null = null;
  for (const key of Object.keys(stages.passes)) {
    const chapter = Number(key);
    if (!Number.isInteger(chapter) || chapter < 1) continue;
    present = true;
    const held = stages.passes[chapter];
    if (held !== undefined) kind = kindOfStage(held.stage);
    const first = (stages.log[chapter] ?? [])[0];
    if (first !== undefined && (startedAt === null || first.at < startedAt)) startedAt = first.at;
    for (const event of stages.log[chapter] ?? []) {
      if (atMs === null || event.at > atMs) atMs = event.at;
    }
  }
  return { present, atMs, kind, startedAt };
}

/** The newest stage event the page has seen, finished passes included (a landing is one). */
function newestStage(stages: HeadStages | null | undefined): { at: number; stage: PassStage } | null {
  if (stages === null || stages === undefined) return null;
  let newest: { at: number; stage: PassStage } | null = null;
  for (const key of Object.keys(stages.log)) {
    // A key with no list behind it (a log a caller built by hand) is no frame at all.
    for (const event of stages.log[Number(key)] ?? []) {
      if (newest === null || event.at > newest.at) newest = { at: event.at, stage: event.stage };
    }
  }
  return newest;
}

/**
 * The head's state and its one word. The fact that a pass is in flight comes from the log's own
 * fold first (the stage frames the page saw), then from the snapshot — a change the queue is
 * processing, then a block carrying the revision mark — so a page that missed the frames still
 * says the book is being written. A pass that has said nothing for 90 s, or an engine that is
 * gone, is `тихо`: the head never claims work it cannot see.
 */
export function headStatusOf({ stages, state, socket, nowMs }: HeadInput): HeadStatus {
  // No live line: the page cannot say what is happening, and it says exactly that.
  if (socket !== undefined && socket !== null && socket !== 'open') {
    return { kind: 'offline', full: HEAD_WORDS.offline, atMs: null, detail: FILING_LINES.noSocket };
  }

  const pass = inFlight(stages);
  const processing = state.queue?.processing ?? null;
  const revising = entriesOf(state.revising);

  if (pass.present || processing !== null || revising.length > 0) {
    const anchor =
      pass.atMs ??
      parseAt(processing?.startedAt) ??
      parseAt(revising[0]?.since) ??
      parseAt(state.engine.heartbeatAt);
    const gone = state.engine.status === 'down' || state.engine.status === 'absent';
    const silent = anchor !== null && nowMs - anchor > HEAD_SILENCE_MS;
    if (!gone && !silent) {
      const kind: HeadKind = pass.kind ?? 'drafting';
      const startMs = parseAt(processing?.startedAt) ?? pass.startedAt;
      return { kind, full: HEAD_WORDS[kind], atMs: anchor, detail: detailOf(kind, startMs) };
    }
  }

  // A landing just happened: the head says `внесено` for the same 90 s a pass would stay legible
  // in, and then it is `тихо` again — the head never claims a moment older than that window.
  const newest = newestStage(stages);
  if (newest !== null && newest.stage === 'landed' && nowMs - newest.at <= HEAD_SILENCE_MS) {
    return { kind: 'landed', full: HEAD_WORDS.landed, atMs: null, detail: null };
  }

  const head = state.queue?.head;
  const depth = state.queue?.depth ?? 0;
  if (head !== null && head !== undefined) {
    return { kind: 'waiting', full: HEAD_WORDS.waiting, atMs: null, detail: null };
  }
  if (head === undefined && depth > 0) {
    return { kind: 'waiting', full: HEAD_WORDS.waiting, atMs: null, detail: null };
  }

  return { kind: 'idle', full: HEAD_WORDS.idle, atMs: null, detail: null };
}

/**
 * The sentence behind a word, when the head can back one: the gates say what they read, and the
 * drafting word carries the real start on the site's own clock. Everything else is the word.
 */
function detailOf(kind: HeadKind, startMs: number | null): string | null {
  if (kind === 'gates') return FILING_LINES.gates;
  if (kind !== 'drafting' || startMs === null) return null;
  return draftingLine(formatTime(new Date(startMs).toISOString()));
}
