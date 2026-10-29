/**
 * BOOK-DOC-84 §10.1/§10.4 — the reading's frames and the price line.
 *
 * Split out of `protocol.ts` when §10's amendment pushed that file past the arch bound; the
 * protocol re-exports these, so a consumer still imports them from `@book/shared`.
 */

import type { StageSpan, WidenedNote } from './stage.ts';
import type { PatchOp } from './protocol.ts';

/** BOOK-DOC-84 §10.1 — where a filing's reading stands. `widened` is a phase of its own; the
 *  desperate sixth and the sink are numbers on the ordinary phases (`desperate`, `comment:decision`). */
export type FilingReadingPhase = 'claimed' | 'read' | 'failed' | 'widened';

/**
 * BOOK-DOC-84 §10.1 — `filing:reading`: one frame per attempt of one filing's reading, exactly
 * one, carrying its number. `reason` is the engine's six-word class, never a sentence;
 * `readingSeq` is `comment_events.id`, the apply cursor of the reading domain.
 */
export type FilingReadingPayload = {
  commentId: string;
  chapter: number;
  phase: FilingReadingPhase;
  /** 1..6 — the try, and the desperate sixth is 6 of 6. */
  attempt: number;
  maxAttempts: number;
  widened: WidenedNote | null;
  desperate: boolean;
  /** ms epoch of the phase's own row. */
  at: number;
  /** The claim's lease end on `claimed` (900 s); `null` off it. */
  deadlineAt: number | null;
  /** The hour the next try is due, on `failed`; `null` otherwise. */
  retryAt: number | null;
  /** One of the six engine classes (`таймаут`, `обрыв связи`, …), `null` off `failed`. */
  reason: string | null;
  /** What the reading cost, on `read`; `null` otherwise. `estimated` says how it is known. */
  costUsd: number | null;
  estimated: boolean;
  /** `comment_events.id` — monotonic; a frame at or below the held cursor is a no-op. */
  readingSeq: number;
};

/** §10.2/§10.8 — the open filing's reading, as a reconnect restores it (never `тихо` over work). */
export type LiveReading = {
  commentId: string;
  chapter: number;
  phase: FilingReadingPhase;
  attempt: number;
  maxAttempts: number;
  widened: WidenedNote | null;
  desperate: boolean;
  /** ms epoch of the phase's own row. */
  since: number;
  /** The claim's lease end on `claimed`, else `null`. */
  deadlineAt: number | null;
  /** The scheduled retry on `failed`, else `null`. */
  retryAt: number | null;
  /** The engine's six-word class on `failed`, else `null`. */
  reason: string | null;
};

/** §10.4: the price line — the last closed unit's cost and the day's total. */
export type LiveCost = {
  kind: 'pass' | 'reading';
  usd: number;
  at: number;
  estimated: boolean;
  /** The UTC day's spend, so the head's price never needs a second request. */
  dayUsd: number;
};

export type LiveApplied = {
  n: number;
  rev: number;
  appliedAt: number;
  patch: PatchOp[];
  patchTruncated: boolean;
  span: StageSpan[] | null;
};

export type LiveQueue = {
  depth: number;
  pending: Array<{ id: string; chapter: number; seq: number; ahead: number; kind: string; enqueuedAt: string }>;
};

export type LiveFiling = {
  commentId: string;
  chapter: number;
  state: string;
  attempts: number;
  attemptsLeft: number;
  changeId: string | null;
  at: string;
};

export type LiveLane = {
  passesToday: number;
  maxPasses: number;
  writerAt: string | null;
};

