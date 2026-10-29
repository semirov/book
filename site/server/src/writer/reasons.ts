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
    return detail.length === 0 ? `движок отказал: ${error.code}` : `движок отказал: ${error.code}: ${detail}`.slice(0, 300);
  }
  if (error instanceof Error && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return `модель не ответила: ${(error as { code: string }).code}`;
  }
  if (error instanceof Error) return `сбой прохода: ${error.name}`;
  return 'сбой прохода';
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
 */
export const readerSentences = {
  shape: 'модель ответила не по форме — правка остановлена',
  modelTimeout: 'модель не ответила вовремя — правка остановлена',
  modelDown: 'модель недоступна — правка остановлена',
  truncated: 'ответ модели оборвался — правка остановлена',
  refusal: 'модель отказалась писать — правка остановлена',
  answerRejected: 'ответ модели не прошёл проверку — правка остановлена',
  engineDown: 'движок не ответил — правка остановлена',
  /** `land` on a step the engine has already closed: nothing was written, so nothing is left. */
  rightsMissing:
    'права на текст не подтверждены — правка остановлена',
  frameChanged:
    'рамка книги — фраза этой главы не меняется, текст не опубликован, правка остановлена',
  stepClosed: 'шаг закрылся, пока текст писался — текст не опубликован, правка остановлена',
  /**
   * BOOK-219: a pass landed its text, the gate never answered, and the pass put the chapter back
   * to the revision it started from. Nothing new is live, and the change is stopped.
   */
  reverted: 'проверка не ответила — текст возвращён к прежней редакции, правка остановлена',
  /**
   * The same pass, and the way back failed: the new text **stands**, unverified. Saying the
   * filing merely waits would hide a published revision; the note says which one, honestly.
   */
  unverified: 'проверка не ответила — новый текст стоит без проверки, правка остановлена',
  /**
   * BOOK-61/BOOK-219: Gate B refused the text. The pass takes its own landing back first, so the
   * reader is never told a refused revision stands — and when the way back fails, the note says
   * the text stands with no rights answer instead of hiding it.
   */
  rightsReverted: 'права на текст не подтверждены — текст возвращён к прежней редакции, правка остановлена',
  rightsUnverified: 'права на текст не подтверждены — новый текст стоит без проверки прав, правка остановлена',
  /**
   * BOOK-219: the engine refused the close itself after the gates answered. The pass took its own
   * landing back (or could not): the reader hears which, never the queue over text that may still
   * be live.
   */
  closeReverted: 'шаг не закрылся — текст возвращён к прежней редакции, правка остановлена',
  closeStanding: 'шаг не закрылся — новый текст стоит без подтверждения, правка остановлена',
} as const;

/**
 * The fallbacks the pass itself passes in: a code the table does not know still owes the reader a
 * sentence, and the code word it came with stays in the log.
 */
export const readerFallbacks = {
  /** Any coded failure with no words of its own. */
  stopped: 'проход остановлен — правка остановлена',
  /** The gates could not be asked: the model's answer never became a verdict. */
  gate: 'ответ модели не прошёл проверку — правка остановлена',
} as const;

function sentenceFor(code: string): string | null {
  if (code === 'PROVIDER_SHAPE') return readerSentences.shape;
  if (code === 'PROVIDER_TIMEOUT') return readerSentences.modelTimeout;
  if (code === 'PROVIDER_UNREACHABLE' || code.startsWith('PROVIDER_HTTP_')) return readerSentences.modelDown;
  if (code === 'ANSWER_TRUNCATED') return readerSentences.truncated;
  if (code === 'ANSWER_REFUSAL') return readerSentences.refusal;
  if (code.startsWith('ANSWER_')) return readerSentences.answerRejected;
  if (code === 'ENGINE_TIMEOUT' || code === 'ENGINE_UNREACHABLE') return readerSentences.engineDown;
  if (code === 'DB_BUSY') return readerSentences.engineDown;
  if (code === 'RIGHTS_REQUIRED' || code === 'RIGHTS_NOT_REQUIRED') return readerSentences.rightsMissing;
  if (code === 'FRAME_CHANGED') return readerSentences.frameChanged;
  if (code === 'STEP_CLOSED') return readerSentences.stepClosed;
  return null;
}

/** The reader's sentence for a code; `fallback` for anything that has none. */
export function readerReason(code: string | null, fallback: string): string {
  const sentence = (sentenceFor((code ?? '').trim().toUpperCase()) ?? fallback).trim();
  return sentence.length <= MAX_CHARS ? sentence : `${sentence.slice(0, MAX_CHARS - 1)}…`;
}
