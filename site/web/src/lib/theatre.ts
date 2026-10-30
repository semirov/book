import type { LiveReading, PassStageEvent } from '@book/shared';

import { printWindowOpen } from './appliedPrint.ts';
import { passSpanOf } from './passDiff.ts';
import type { AppliedWrite } from './clientState.ts';
import { isAlive, type SentenceFilings } from './filings.ts';
import { failedAttempt, filingMarginalia, type FilingFacts } from './marginalia.ts';

/**
 * BOOK-227 / BOOK-DOC-86 — the theatre of one filing, as one pure function.
 *
 * The page performs only what a **frame** told it (honesty rule 2): the read's claim, the
 * writer's stage, the reader's decision, the write, the gates, the sink. `theatreOf` is the
 * whole rule, and it is a *clock*, not a script: every act carries the epoch ms of the fact
 * that started it (`since`), and the act on screen is the **latest** fact the page holds. The
 * later sink therefore wins in place — the 12 ms `landed` → `refused` of §6 rule 4 — and no
 * act ever leaves a mark it was not framed for, because nothing is remembered between calls.
 *
 * Precedence, earliest → latest (§2, §9):
 *
 *   arrival   `filing:reading{claimed}` — the live claim only; a reader's own post is not a
 *             read and starts nothing (§6 rule 6);
 *   thinking  `pass:stage{drafting}`, only while that stage is the pass's newest;
 *   verdict   the filing's own decision — accepted, held, refused;
 *   queue     an accepted filing the lane has not reached yet (`changeStatus: pending`);
 *   writing   `chapter:applied` names the sentence's block, and the page is inside the print's
 *             own window — the ink is the print's (§121, `PrintPass`), the spine and the margin
 *             are ours;
 *   checking  the round's `pass:stage{verdict}` gates, one tally each;
 *   landing   the sink that made the filing the text;
 *   failed    our fault (a failed attempt) or a gate's verdict — plus the transport, which
 *             stops the marks and adds none.
 *
 * Two negative rules carry the honesty of the whole page and are tested as such: **no frame,
 * no act** (a filing nobody is reading has none), and **no replay** — a decision older than
 * `WITNESS_MS` is a fact the page did not witness, so the mark is already the settled shape
 * and nothing is performed (§6 rule 6, "a late reader").
 */

/** The reader's pace: 230 words a minute (BOOK-DOC-86 §2). The sweep is derived from it. */
export const READ_WPM = 230;
/** A two-word sentence must not flash: the sweep's only floor, and the only cap is none. */
export const SWEEP_FLOOR_MS = 1_200;
/** §8.1 — below 90 ms a word the pen would batch; unreachable at 230 wpm, kept as a guard. */
export const WORD_BATCH_MS = 90;
/** §9.6 — the tally's duration is its height's: one line box per 120 ms, clamped. */
export const TALLY_LINE_MS = 120;
export const TALLY_FLOOR_MS = 240;
export const TALLY_CEIL_MS = 1_200;
/**
 * §9.3 — the queue's own beat: the stub's 120 ms contraction, the rule closing and the 400 ms
 * hold. The queue's shape starts no earlier than that after the verdict's frame.
 */
export const QUEUE_BEAT_MS = 520;
/** §9.5 — a round accumulates its gates, never more than three (4 px apart). */
export const MAX_TALLIES = 3;
/** A decision older than this was not witnessed by the page: it is not performed. */
export const WITNESS_MS = 120_000;

export type ActKind =
  | 'arrival'
  | 'thinking'
  | 'verdict'
  | 'queue'
  | 'writing'
  | 'checking'
  | 'landing'
  | 'failed';

export type VerdictOutcome = 'accepted' | 'held' | 'refused';
export type FailureCause = 'fault' | 'verdict' | 'transport';

export type Act =
  | { kind: 'arrival'; since: number; words: number; deadlineAt: number | null }
  | { kind: 'thinking'; since: number; deadlineAt: number | null }
  | { kind: 'verdict'; since: number; outcome: VerdictOutcome; word: string; detail: string }
  | { kind: 'queue'; since: number; ahead: number | null }
  | { kind: 'writing'; since: number; blocks: readonly string[] }
  | { kind: 'checking'; since: number; tallies: number }
  | { kind: 'landing'; since: number; word: string }
  | { kind: 'failed'; since: number; cause: FailureCause; word: string; detail: string };

/** The filing's own decision, as the page holds it (the row's status and its moment). */
export type TheatreDecision = {
  at: number;
  outcome: VerdictOutcome | 'landed';
  word: string;
  detail: string;
};

/** A stop that is not a decision: the engine's own «не дошло» (§9.8, our fault). */
export type TheatreFailure = {
  at: number;
  cause: Extract<FailureCause, 'fault' | 'verdict'>;
  word: string;
  detail: string;
};

/**
 * The read, as `lib/filingLive.ts` publishes it (BOOK-220 §11.3): the frame's own phase and
 * moment, never a clock the page keeps. `read`/`failed`/`widened` end the arrival; only a
 * `claimed` phase starts one.
 */
export type TheatreReading = Pick<LiveReading, 'phase' | 'since' | 'deadlineAt'>;

export type TheatreInput = {
  /** The sentence's filings — `null` when the anchor no longer resolves. */
  filings: SentenceFilings | null;
  /** The live claim of this filing's read, or `null` when the frame named another row. */
  reading: TheatreReading | null;
  /** The pass log of the sentence's chapter, from `ClientState.stages`. */
  stages: readonly PassStageEvent[] | null;
  /** The last decision the page heard about this filing, or `null`. */
  decision: TheatreDecision | null;
  /** The lane holds the filing's change (`changeStatus: processing`). */
  processing: boolean;
  /** A stop that is not a verdict — the engine's failed attempt. */
  failed: TheatreFailure | null;
  /** The chapter's `chapter:applied`/`live.applied` write, when the page holds one. */
  applied: AppliedWrite | null;
  /** A dead transport stops every mark and adds none (§9.8). */
  transport: 'up' | 'down';
  /** Epoch ms of this frame. */
  now: number;
};

/* ------------------------------------------------------------------ the clock ---- */

/**
 * `sweepMs = max(visible_words × 60 000 ÷ 230, 1 200)` — no ceiling (§9.1). A two-word sentence
 * takes 1 200 ms because the floor may slow a word below 230 wpm, and that is its job.
 */
export function sweepOf(visibleWords: number): number {
  if (!Number.isFinite(visibleWords) || visibleWords <= 0) return SWEEP_FLOOR_MS;
  return Math.max(Math.floor((visibleWords * 60_000) / READ_WPM), SWEEP_FLOOR_MS);
}

/** `sweepMs ÷ visible_words` — one press per word, never two steps (§8.1). */
export function wordMsOf(sweepMs: number, visibleWords: number): number {
  if (visibleWords <= 0) return sweepMs;
  return sweepMs / visibleWords;
}

/**
 * §8.1's batching branch, kept as the guard it is: `max(1, ⌈90 ÷ wordMs⌉)` = **1** for every
 * sentence the page can have, because the floor keeps a word at ≥ 260.87 ms.
 */
export function groupsOf(wordMs: number): number {
  if (!Number.isFinite(wordMs) || wordMs <= 0) return 1;
  return Math.max(1, Math.ceil(WORD_BATCH_MS / wordMs));
}

/**
 * How many words are inked `elapsed` ms after the claim: `k = min(n, ⌊e × n ÷ sweepMs⌋ + 1)`.
 * The first word is inked by the frame that arrives, so `k` is never 0 while `n > 0`.
 */
export function inkedAt(elapsed: number, sweepMs: number, words: number): number {
  if (words <= 0) return 0;
  if (elapsed <= 0) return 1;
  if (sweepMs <= 0) return words;
  return Math.min(words, Math.floor((elapsed * words) / sweepMs) + 1);
}

/** §9.6 — `clamp(120 × lines, 240, 1 200)` ms, `linear`: the ink's pace is one line box. */
export function tallyMs(lines: number): number {
  if (!Number.isFinite(lines) || lines <= 0) return TALLY_FLOOR_MS;
  return Math.min(Math.max(TALLY_LINE_MS * lines, TALLY_FLOOR_MS), TALLY_CEIL_MS);
}

/* --------------------------------------------------------------- the row's facts ---- */

/** The filing a sentence performs: the alive one, else the latest record. */
export function performedFiling(filings: SentenceFilings | null): SentenceFilings['all'][number] | null {
  if (filings === null) return null;
  return filings.all.find(isAlive) ?? filings.all[0] ?? null;
}

/** Words as the pen walks them: whitespace-separated, in order, with their offsets. */
export function wordsOf(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const pattern = /\S+/gu;
  let match = pattern.exec(text);
  while (match !== null) {
    out.push({ start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return out;
}

function parseAt(value: string | null | undefined): number {
  if (value === null || value === undefined || value.length === 0) return 0;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

/**
 * The filing's last decision, from the row the page holds. The durable row already carries the
 * server's derived status (`comments/states.ts`), so this is a reading, never a second rule —
 * and a row the page loaded as `rejected` an hour ago reads as a decision the page did not
 * witness, which `theatreOf` refuses to perform.
 */
export function decisionOf(comment: FilingFacts & { decidedAt?: string | null }): TheatreDecision | null {
  const marginalia = filingMarginalia(comment);
  const at = parseAt(comment.decidedAt);
  switch (comment.status) {
    case 'accepted':
      return { at, outcome: 'accepted', word: marginalia.word, detail: marginalia.consequence };
    case 'applied':
      return { at, outcome: 'landed', word: marginalia.word, detail: marginalia.consequence };
    case 'quarantined':
      return { at, outcome: 'held', word: marginalia.word, detail: marginalia.consequence };
    case 'rejected':
    case 'hidden':
      return { at, outcome: 'refused', word: marginalia.word, detail: marginalia.consequence };
    default:
      return null;
  }
}

/** Our fault, when the record itself says the attempt came back empty (§9.8). */
export function failureOf(
  comment: FilingFacts & { decidedAt?: string | null },
): TheatreFailure | null {
  if (!failedAttempt(comment)) return null;
  const marginalia = filingMarginalia(comment);
  return { at: parseAt(comment.decidedAt), cause: 'fault', word: marginalia.word, detail: marginalia.consequence };
}

/* ------------------------------------------------------------------- the gates ---- */

/** The pass's newest stage for the chapter — one pass's story, not two. */
export function newestStage(stages: readonly PassStageEvent[] | null): PassStageEvent | null {
  if (stages === null || stages.length === 0) return null;
  let newest: PassStageEvent | null = null;
  for (const event of stages) {
    if (newest === null || event.at > newest.at || (event.at === newest.at && event.stageSeq > newest.stageSeq)) {
      newest = event;
    }
  }
  return newest;
}

/**
 * The gates of the open round: `pass:stage{verdict}` frames of the pass whose newest stage is a
 * gate, one tally each, never more than three. A pass that is not past its draft call — or one
 * that only read — draws nothing (§9.6).
 */
export function talliesOf(stages: readonly PassStageEvent[] | null): number {
  if (stages === null) return 0;
  const open = newestStage(stages);
  if (open === null || open.stage !== 'verdict') return 0;
  const gates = stages.filter((event) => event.passId === open.passId && event.stage === 'verdict');
  return Math.min(gates.length, MAX_TALLIES);
}

/* -------------------------------------------------------------------- the write ---- */

/**
 * The blocks a write names, as the print itself decides to ink them (§121
 * `appliedPrintPlans`): a truncated patch or a missing span prints nothing, and a truncated
 * side is half a sentence — so those name no block here either. The page's `chapter:applied`
 * is the *chapter's* fact; the theatre performs it only on the sentence it changed.
 */
export function writtenBlocks(applied: AppliedWrite | null): string[] {
  if (applied === null || applied.patchTruncated || applied.span === null) return [];
  return applied.span.filter((entry) => !entry.truncated && entry.blockId !== null).map((entry) => entry.blockId as string);
}

/**
 * §9.2/§9.4 — the writing act: the block is held while the print inks it. The clock is the
 * write's own `appliedAt` and the window is the print's (`PRINT_WINDOW_MS`): past it the text
 * is simply there, and nothing is performed (BOOK-DOC-86 §9.4, "the cap is retired" — the
 * window is a *start*, never a share of the print, whose length the page never counts).
 */
export function writingOf(
  applied: AppliedWrite | null,
  blockId: string | null,
  now: number,
): { since: number; blocks: readonly string[] } | null {
  if (applied === null || blockId === null) return null;
  if (!printWindowOpen(applied, now)) return null;
  const blocks = writtenBlocks(applied);
  if (!blocks.includes(blockId)) return null;
  return { since: applied.appliedAt, blocks };
}

/**
 * §9.5 / BOOK-233 item 1 — the **run** a write's span names for this block, cut the way the print
 * cuts it (`passDiff.ts`, the same function `PrintPass` inks from): the text it wrote, or the text
 * it took away when the write only deleted. The span's own `before`/`after` are the whole block,
 * so the run is the diff's, never the entry's. `null` when the write names no block here.
 */
export function writtenRunOf(applied: AppliedWrite | null, blockId: string | null): string | null {
  if (applied === null || blockId === null || applied.span === null) return null;
  for (const entry of applied.span) {
    if (entry.blockId !== blockId || entry.truncated) continue;
    const span = passSpanOf(entry.before, entry.after);
    if (span === null) continue;
    if (span.after.length > 0) return span.after;
    if (span.before.length > 0) return span.before;
  }
  return null;
}

/* ----------------------------------------------------------------- the machine ---- */

/**
 * The order of the ties. Two acts can share a moment — `landing` and `writing` both carry the
 * write's own `appliedAt` when the row has already landed (the receipt is the print's), and the
 * ink outranks the mark it will leave: the reader watches the print, then the landing beat. The
 * order of the §2 states decides everything else.
 */
const RANK: Readonly<Record<ActKind, number>> = {
  arrival: 0,
  thinking: 1,
  verdict: 2,
  queue: 3,
  landing: 4,
  writing: 5,
  checking: 6,
  failed: 7,
};

/** The act on screen, or `null` when no frame gives the sentence one. */
export function theatreOf(input: TheatreInput): Act | null {
  const { filings, reading, stages, decision, processing, failed, applied, transport, now } = input;
  // A filing with no sentence — a stale anchor — stands on nothing: no act (§2).
  if (filings === null || filings.quote === null || filings.stale) return null;
  const row = performedFiling(filings);
  if (row === null) return null;

  // A dead transport cannot frame its own death: the marks stop where they are and no
  // per-sentence mark is added (§9.8). The renderer paints nothing new for this act.
  if (transport === 'down') {
    return { kind: 'failed', since: now, cause: 'transport', word: '', detail: '' };
  }

  const candidates: Act[] = [];
  const witnessed = (at: number): boolean => at > 0 && now - at <= WITNESS_MS;

  // arrival — the live claim only: `claimed` is a read in flight, and every other phase of the
  // frame (`read`, `failed`, `widened`) has already ended it. The reader's own post writes none.
  if (reading !== null && reading.phase === 'claimed') {
    candidates.push({
      kind: 'arrival',
      since: reading.since,
      words: wordsOf(filings.quote ?? '').length,
      deadlineAt: reading.deadlineAt,
    });
  }

  const stage = newestStage(stages);
  // thinking — the draft call, while the pass is open: drafting is its newest stage, so a later
  // stage of the same pass (a gate, a landing) already ended the waiting.
  if (stage !== null && stage.stage === 'drafting') {
    // §9.2 — the deadline is a fact of the frame, never a clock the page invents: a stage that
    // carries none starts no timer at all.
    const deadline = (stage as PassStageEvent & { deadlineAt?: unknown }).deadlineAt;
    const deadlineAt =
      typeof deadline === 'number' && Number.isFinite(deadline) && deadline > stage.at ? deadline : null;
    candidates.push({ kind: 'thinking', since: stage.at, deadlineAt });
  }

  const decided = decision !== null && witnessed(decision.at) ? decision : null;
  // Our fault is a stop, not a state of waiting: an accepted row whose attempt came back empty
  // must not be turned into a queue place by the beat below (§9.8 — the footnote stays while the
  // note still says «не дошло»).
  const stop = failed !== null && witnessed(failed.at) ? failed : null;
  if (decided !== null) {
    if (decided.outcome === 'landed') {
      // The sink's moment is the write's, when the receipt on the row is the write the page holds:
      // `decidedAt` is the acceptance, minutes before the text.
      const receipt = row.applied ?? null;
      const at = applied !== null && receipt !== null && applied.rev === receipt.rev
        ? Math.max(decided.at, applied.appliedAt)
        : decided.at;
      candidates.push({ kind: 'landing', since: at, word: decided.word });
    } else {
      candidates.push({
        kind: 'verdict',
        since: decided.at,
        outcome: decided.outcome,
        word: decided.word,
        detail: decided.detail,
      });
      // queue — an accepted filing the lane has not reached: stillness after the verdict's own
      // beat (120 + 400 ms), never during it, so the press and the stub are seen once.
      if (decided.outcome === 'accepted' && !processing && stop === null) {
        candidates.push({ kind: 'queue', since: decided.at + QUEUE_BEAT_MS, ahead: null });
      }
    }
  }

  // writing — the block this sentence stands in is being inked, inside the print's own window.
  const writing = writingOf(applied, filings.blockId, now);
  if (writing !== null) {
    candidates.push({ kind: 'writing', since: writing.since, blocks: writing.blocks });
  }

  // checking — the round's gates, one tally per gate the page saw start.
  const tallies = talliesOf(stages);
  if (tallies > 0 && stage !== null) {
    candidates.push({ kind: 'checking', since: stage.at, tallies });
  }

  if (stop !== null) {
    candidates.push({
      kind: 'failed',
      since: stop.at,
      cause: stop.cause,
      word: stop.word,
      detail: stop.detail,
    });
  }

  // A fact that has not happened yet is not a fact: the queue's beat starts 520 ms after the
  // verdict, and until the clock reaches it the verdict is the last thing the page saw.
  const happened = candidates.filter((one) => one.since <= now);
  if (happened.length === 0) return null;
  return happened.reduce((best, one) => {
    if (one.since !== best.since) return one.since > best.since ? one : best;
    return RANK[one.kind] > RANK[best.kind] ? one : best;
  });
}
