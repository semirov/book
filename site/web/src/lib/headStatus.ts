/**
 * BOOK-207 / BOOK-DOC-84 D3 — the book's state in the running head's free space.
 *
 * One word about now and nothing else, in the book's own voice and in the stage's own name:
 *
 *   queued · read         → «сейчас читает»
 *   drafting              → «сейчас пишется»
 *   verdict               → «сейчас проверяют»
 *   landed · applied ≤2 s → «сейчас записывает»
 *
 * No open pass → the word is **absent** (idle is not a state the book needs to announce). An
 * open pass past its own deadline (its stage's `since` + `STAGE_DEADLINE_MS`) or an engine that
 * is `down`/`absent` → «сейчас тихо». The 90 s silence bound is gone: an open gate is 381 s of
 * real work, and calling that silence was the lie that made the owner read "stopped".
 *
 * The state is a pure function of the frame facts (`live.passes`, the local stage log, the
 * write's `appliedAt`, the last close) and a clock handed in, so the deadline is a test and not
 * a wait.
 */

import { STAGE_DEADLINE_MS, type EngineStatus, type LivePass } from '@book/shared';

import type { StagesLog } from './stages.ts';

/** How long after a write or a close the head still says the book is writing. */
export const APPLY_WORD_MS = 2_000;

export const HEAD_READING = 'сейчас читает';
export const HEAD_WRITING = 'сейчас пишется';
export const HEAD_CHECKING = 'сейчас проверяют';
export const HEAD_APPLYING = 'сейчас записывает';
export const HEAD_QUIET = 'сейчас тихо';

export type HeadKind = 'reading' | 'writing' | 'checking' | 'applying' | 'quiet' | 'idle';

/** The word and its end: everything the head says about what the machine is doing now. */
export type HeadWord = {
  kind: HeadKind;
  /** The one word, or `null` when the head prints nothing at all. */
  full: string | null;
  /** The moment this word stops being true, epoch ms — what the head's one timer reads. */
  untilMs: number | null;
};

export type HeadStatus = HeadWord & {
  /**
   * BOOK-220 M2 — the bound's own sentence beside the word («на сегодня всё»,
   * «правки приостановлены»). It never replaces the stage's word, and it is absent unless the
   * fact is true: a lane below its cap and a running engine say nothing here.
   *
   * BOOK-207 — no count in the head: the lane's numbers decide *whether* the sentence shows and
   * are never printed, because a counter on the head can lie the moment a frame is late.
   */
  note: string | null;
};

/** The one field the head reads from the engine: whether the machine is working at all. */
export type HeadEngine = { status: EngineStatus; reason?: string | null } | null;

/** The lane's day bound, as `engine:state`/`hello.live.lane` carry it. */
export type HeadLane = { passesToday: number; maxPasses: number } | null;

export type HeadInput = {
  /** The open passes of `live.passes` (or the page's own fold of them). */
  passes?: readonly LivePass[] | null;
  /** The local stage log: a stage frame the page heard after the snapshot wins over it. */
  stages?: StagesLog | null;
  /** The engine's reason line (`engine:state`) or the snapshot's own engine block. */
  engine?: HeadEngine;
  /** The lane's day (`live.lane` / `engine:state`): its cap is the one sentence the head owes. */
  lane?: HeadLane;
  /** The write's own clock (`chapter:applied` / `live.applied`). */
  appliedAt?: number | null;
  /** The newest `pass:closed`. */
  closedAt?: number | null;
  nowMs: number;
};

const WORDS: Record<string, string> = {
  queued: HEAD_READING,
  read: HEAD_READING,
  verdict: HEAD_CHECKING,
  drafting: HEAD_WRITING,
  typing: HEAD_WRITING,
};

const idle: HeadWord = { kind: 'idle', full: null, untilMs: null };
const quiet: HeadWord = { kind: 'quiet', full: HEAD_QUIET, untilMs: null };

/** The pass's own latest stage: the log's event when one arrived, else the snapshot's stage. */
function latestStage(pass: LivePass, stages: StagesLog | null | undefined): { stage: string; since: number } {
  if (stages === null || stages === undefined) return { stage: pass.stage, since: pass.since };
  let newest: { stage: string; since: number; stageSeq: number } | null = null;
  for (const events of Object.values(stages)) {
    for (const event of events) {
      if (event.passId !== pass.passId) continue;
      if (newest === null || event.stageSeq > newest.stageSeq) {
        newest = { stage: event.stage, since: event.at, stageSeq: event.stageSeq };
      }
    }
  }
  return newest === null ? { stage: pass.stage, since: pass.since } : { stage: newest.stage, since: newest.since };
}

/** The word itself, without the bound's note: the stage's own name and its end. */
function wordOf({ passes, stages, engine, appliedAt, closedAt, nowMs }: HeadInput): HeadWord {
  // An engine that is gone cannot be working: the honest word is quiet, not a stale stage.
  if (engine !== null && engine !== undefined && (engine.status === 'down' || engine.status === 'absent')) {
    return quiet;
  }

  // The write is the one fact worth a word of its own: for two seconds the page is printing.
  const written = [appliedAt ?? null, closedAt ?? null].filter((at): at is number => at !== null);
  const newestWrite = written.length === 0 ? null : Math.max(...written);
  if (newestWrite !== null && nowMs - newestWrite >= 0 && nowMs - newestWrite < APPLY_WORD_MS) {
    return { kind: 'applying', full: HEAD_APPLYING, untilMs: newestWrite + APPLY_WORD_MS };
  }

  const open = [...(passes ?? [])].sort((left, right) => right.since - left.since);
  const newest = open[0];
  if (newest === undefined) return idle;

  const latest = latestStage(newest, stages);
  // A pass that landed or was refused has said its last word: the head does not keep claiming it.
  if (latest.stage === 'landed' || latest.stage === 'refused') return idle;
  const deadlineAt = latest.since + STAGE_DEADLINE_MS;
  if (nowMs > deadlineAt) return quiet;
  const full = WORDS[latest.stage];
  // A stage the vocabulary does not name is not guessed at: the head stays quiet about it.
  if (full === undefined) return { kind: 'quiet', full: HEAD_QUIET, untilMs: deadlineAt };
  const kind: HeadKind = full === HEAD_READING ? 'reading' : full === HEAD_CHECKING ? 'checking' : 'writing';
  return { kind, full, untilMs: deadlineAt };
}

/**
 * The bound's own sentence (BOOK-220 M2), beside the word and never instead of it: the lane's
 * day cap and the engine's own reason. Only a true fact is printed — a lane below its cap, an
 * engine that is working, and an engine with no reason of its own say nothing at all.
 */
function noteOf({ engine, lane }: HeadInput): string | null {
  // BOOK-207: the lane's numbers are the question, never the answer — the head prints the bound
  // as one sentence and no count beside it.
  if (lane !== null && lane !== undefined && lane.maxPasses > 0 && lane.passesToday >= lane.maxPasses) {
    return 'на сегодня всё';
  }
  if (engine === null || engine === undefined) return null;
  const reason = engine.reason?.trim() ?? '';
  if (reason.length === 0) return null;
  // `engine:state.reason` is the server's own sentence («правки приостановлены», «дневной
  // лимит правок»); a working engine's line says nothing a reader needs twice.
  return engine.status === 'paused' || engine.status === 'throttled' ? reason : null;
}

export function headStatusOf(input: HeadInput): HeadStatus {
  return { ...wordOf(input), note: noteOf(input) };
}
