/**
 * The two voices of a stopped pass (`docs/writer-lane.md` §1, §5–§6).
 *
 * The **note** — what `escalate` writes into `steps.note` and `changes.reason`, and what the
 * `refused` stage shows — is a sentence for whoever reads it: a machine code is not an answer to
 * "why did my chapter stop" (the owner's rule, 2026-10-28: "the note in the DB must never be a
 * code word alone"). The **code** and the technical detail stay in the process log and in the
 * transcript, which is where an operator looks and where a post-mortem reads them.
 *
 * Everything here is pure: no clock, no config, no engine, no I/O — so the mapping can be pinned
 * line by line by a test.
 */

import { STOP_REASONS, stopReasonKey, type StopReason } from '@book/shared';

import type { PremiseCause } from '../engine/types.ts';

import { EngineRefusalError, isEngineTransportCode } from './client.ts';

/** A refusal the lane states in its own words (never a provider key, never a URL). */
export class PassRefusal extends Error {
  /** The machine code behind the sentence, when there is one: it never reaches the note. */
  readonly code: string | null;

  constructor(reason: string, code: string | null = null) {
    super(reason);
    this.name = 'PassRefusal';
    this.code = code;
  }
}

/** Whatever went wrong, in one plain sentence an operator (and the log) can carry. */
export function reasonOf(error: unknown): string {
  if (error instanceof PassRefusal) return error.message;
  if (error instanceof EngineRefusalError) {
    const detail = error.message.trim();
    return detail.length === 0 ? `машина отказала: ${error.code}` : `машина отказала: ${error.code}: ${detail}`.slice(0, 300);
  }
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return `машина не ответила: ${(error as { code: string }).code}`;
  }
  if (error instanceof Error) return `сбой машины: ${error.name}`;
  return 'сбой машины';
}

/** The machine code an error carries, when it carries one (`null` for a plain sentence). */
export function codeOf(error: unknown): string | null {
  if (error instanceof PassRefusal) return error.code;
  if (error instanceof EngineRefusalError) return error.code;
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return null;
}

/** A failure, split the way the two surfaces need it: a code for the log, a sentence for the note. */
export type Failure = { code: string | null; detail: string };

export function failureOf(error: unknown): Failure {
  return { code: codeOf(error), detail: reasonOf(error) };
}

/** Fix 1's codes: the engine did not answer — which is neither the model nor a gate. */
export function isTransportFailure(failure: Failure): boolean {
  return isEngineTransportCode(failure.code);
}

/**
 * What a stop is made of, in the two voices this file keeps apart: `detail` is the technical
 * sentence for the log and the transcript, `fallback` the reader's sentence for a code the table
 * does not know. A code never reaches the note.
 */
export type ParkInput = {
  code?: string | null;
  detail: string;
  fallback?: string;
  cause?: PremiseCause;
  /**
   * A sentence the pass names itself, used **instead of** the code's own (BOOK-219): a pass that
   * put its own landed text back cannot be read as a queue place — what happened to the text is
   * the fact the reader needs, and it is not one code's answer.
   */
  sentence?: string;
};

/** A note is read on a page and inside a stage summary: it is bounded here, once. */
const MAX_CHARS = 200;

/**
 * The reader's words, one sentence per way a pass can stop. Short on purpose: the note is copied
 * into a stage summary, and a summary is a single line.
 *
 * The register is **stopped**, never queued (BOOK-219, audit B2/B5): a parked pass escalates the
 * step, and an escalated change is a terminal filing state (`rejected`, one word on every
 * surface — `comments/states.ts`) — nothing retries it, so «заявка остаётся в очереди» and
 * «заявка ждёт решения» are both lies. Every sentence therefore names what happened to the text
 * and says «правка остановлена»: the word `follow.ts` prints for `escalated`.
 *
 * BOOK-218: the sentences themselves live in `@book/shared`'s `stateWords.ts` — this table only
 * names the key each code maps to.
 */
/** BOOK-173 — the ripple's own stops: codes the shared register does not name yet. */
type RippleStopKey =
  | 'notARipple'
  | 'planMissing'
  | 'notPlanned'
  | 'neighbourMissing'
  | 'invalidChapter'
  | 'wideNeedsAuthor'
  | 'rippleRefused'
  | 'chapterRefused'
  | 'closureUnstable'
  | 'closureBound'
  | 'closureDrift'
  | 'irreversibleLost'
  | 'laneLost'
  | 'judgeVeto'
  | 'tier0Failed'
  | 'triageRequired'
  /** BOOK-219: our own failures — the close published nothing, or the machinery broke. */
  | 'technical'
  | 'closeNotPublished';

export const readerSentences: Readonly<
  Record<Exclude<StopReason, 'stopped' | 'gate'> | RippleStopKey, string>
> = {
  shape: STOP_REASONS.shape,
  modelTimeout: STOP_REASONS.modelTimeout,
  modelDown: STOP_REASONS.modelDown,
  truncated: STOP_REASONS.truncated,
  refusal: STOP_REASONS.refusal,
  answerRejected: STOP_REASONS.answerRejected,
  engineDown: STOP_REASONS.engineDown,
  /** `land` on a step the engine has already closed: nothing was written, so nothing is left. */
  rightsMissing: STOP_REASONS.rightsMissing,
  frameChanged: STOP_REASONS.frameChanged,
  stepClosed: STOP_REASONS.stepClosed,
  /** BOOK-219: a landing taken back after a silent gate, or the text it could not take back. */
  reverted: STOP_REASONS.reverted,
  unverified: STOP_REASONS.unverified,
  rightsReverted: STOP_REASONS.rightsReverted,
  rightsUnverified: STOP_REASONS.rightsUnverified,
  closeReverted: STOP_REASONS.closeReverted,
  closeStanding: STOP_REASONS.closeStanding,
  closeUncertain: STOP_REASONS.closeUncertain,
  /**
   * BOOK-173: the ripple's own refusals, keyed by code in `sentenceFor`. The codes are the closed
   * list of the ripple's doors (the engine's, the drainer's, the judge's); the sentence is the
   * register's one stop line — BOOK-218's rule is that a stop reads the same wherever it happened,
   * and a ripple stop is our failure, never a verdict about the reader's edit.
   */
  notARipple: STOP_REASONS.stopped,
  planMissing: STOP_REASONS.stopped,
  notPlanned: STOP_REASONS.stopped,
  neighbourMissing: STOP_REASONS.stopped,
  invalidChapter: STOP_REASONS.stopped,
  wideNeedsAuthor: STOP_REASONS.stopped,
  rippleRefused: STOP_REASONS.stopped,
  chapterRefused: STOP_REASONS.stopped,
  closureUnstable: STOP_REASONS.stopped,
  closureBound: STOP_REASONS.stopped,
  closureDrift: STOP_REASONS.stopped,
  irreversibleLost: STOP_REASONS.stopped,
  laneLost: STOP_REASONS.stopped,
  judgeVeto: STOP_REASONS.stopped,
  /** BOOK-DOC-80: the countable checks refused the patch; the codes live in the log. */
  tier0Failed: STOP_REASONS.stopped,
  /** BOOK-206 + BOOK-173 §4: the filing the patch would be written from has not been read yet. */
  triageRequired: STOP_REASONS.stopped,
  /**
   * BOOK-219 — our own failure, said as ours: the close did not publish what the pass wrote, and
   * the way back is a retry. A refusal of the **text** never borrows either sentence.
   */
  technical: STOP_REASONS.shape,
  closeNotPublished: STOP_REASONS.shape,
};

/**
 * The fallbacks the pass itself passes in: a code the table does not know still owes the reader a
 * sentence, and the code word it came with stays in the log.
 */
export const readerFallbacks = {
  /** Any coded failure with no words of its own. */
  stopped: STOP_REASONS.stopped,
  /** The gates could not be asked: the model's answer never became a verdict. */
  gate: STOP_REASONS.gate,
} as const;

function sentenceFor(code: string): string | null {
  const key = stopReasonKey(code);
  if (key !== null && key !== 'stopped' && key !== 'gate') return readerSentences[key];
  // BOOK-173: the ripple's own refusals — codes the shared register does not name yet. Each has
  // its sentence above, so no code word reaches a note, a stage summary or `change_plans.park_reason`.
  if (code === 'NOT_A_RIPPLE') return readerSentences.notARipple;
  if (code === 'PLAN_MISSING') return readerSentences.planMissing;
  if (code === 'NOT_PLANNED') return readerSentences.notPlanned;
  if (code === 'NEIGHBOUR_MISSING') return readerSentences.neighbourMissing;
  if (code === 'INVALID_CHAPTER') return readerSentences.invalidChapter;
  if (code === 'WIDE_NEEDS_AUTHOR') return readerSentences.wideNeedsAuthor;
  if (code === 'RIPPLE_REFUSED') return readerSentences.rippleRefused;
  if (code === 'CHAPTER_REFUSED') return readerSentences.chapterRefused;
  if (code === 'CLOSURE_UNSTABLE') return readerSentences.closureUnstable;
  if (code === 'CLOSURE_BOUND') return readerSentences.closureBound;
  if (code === 'CLOSURE_DRIFT' || code === 'FACT_DANGLING' || code === 'CAUSE_UNSUPPORTED') {
    return readerSentences.closureDrift;
  }
  if (code === 'IRREVERSIBLE_LOST') return readerSentences.irreversibleLost;
  if (code === 'LANE_LOST') return readerSentences.laneLost;
  if (code === 'JUDGE_VETO') return readerSentences.judgeVeto;
  // BOOK-DOC-80: the countable tier refused the patch; no model was asked after it.
  if (code === 'TIER0_FAILED') return readerSentences.tier0Failed;
  // BOOK-206: the patch waits for the filing's own read — the writer buys it, nobody else can.
  if (code === 'TRIAGE_REQUIRED') return readerSentences.triageRequired;
  return null;
}

/** The reader's sentence for a code; `fallback` for anything that has none. */
export function readerReason(code: string | null, fallback: string): string {
  const sentence = (sentenceFor((code ?? '').trim().toUpperCase()) ?? fallback).trim();
  return sentence.length <= MAX_CHARS ? sentence : `${sentence.slice(0, MAX_CHARS - 1)}…`;
}
