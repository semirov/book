import type { CommentBudget, ComposerInfo, InterventionKind } from '@book/shared';
import {
  COMMENT_MAX_CHARS,
  COMMENT_MIN_CHARS,
  EDIT_MAX_CHARS,
  INTERVENTION_KIND_LABELS,
  PREMISE_FROZEN_REASON,
} from '@book/shared';

import { premiseRefusal } from './premise.ts';

/**
 * BOOK-33 — the bounds, the refusal lines and the draft rules the seam's form still uses.
 *
 * The bottom composer is gone, so its state machine (`composerView`, the target picker) went
 * with it; what survives is what the form needs: the caps that arrive in `hello`, one public
 * line per refusal code, and the client-side draft check that never has the last word.
 */

/**
 * Before `hello` arrives the form shows the same caps the server will confirm, taken from the
 * shared constants rather than from a local copy (BOOK-DOC-4 rule 1).
 */
export const EMPTY_COMPOSER: ComposerInfo = {
  minChars: COMMENT_MIN_CHARS,
  maxChars: COMMENT_MAX_CHARS,
  editMaxChars: EDIT_MAX_CHARS,
};

/**
 * Which surface a refusal answers (BOOK-84): a written chapter's filing, or the **premise** of
 * a chapter with no text yet. An empty chapter's seam carries `blockId === null`, and that one
 * fact decides the words below it.
 */
export type RefusalSurface = 'chapter' | 'premise';

/** The words one refusal shows: the line, its detail, and whether the reader may try again. */
export type RefusalCopy = { line: string; detail: string | null; canRetry: boolean };

/**
 * The line a signed-out reader gets, and the fine print under it. BOOK-84: a premise's gate
 * asks for the act the form will really perform — «заложить замысел» — because the strip above
 * it says the two filings are different things. One table, so the gate and `errorCopy` cannot
 * drift apart on either surface.
 */
const SIGNIN_LINES: Readonly<Record<RefusalSurface, string>> = {
  chapter: 'войдите через Яндекс, чтобы оставить замечание',
  premise: 'войдите через Яндекс, чтобы заложить замысел',
};

const SIGNIN_FINE_LINES: Readonly<Record<RefusalSurface, string>> = {
  chapter: 'Читать можно без входа. Автор замечания виден другим читателям.',
  premise: 'Читать можно без входа. Автор замысла виден другим читателям.',
};

/** The signed-out gate of one surface: its line and the sentence under it. */
export function signinCopy(surface: RefusalSurface): { line: string; fine: string } {
  return { line: SIGNIN_LINES[surface], fine: SIGNIN_FINE_LINES[surface] };
}

export type ComposerError = {
  code: string;
  message: string;
  retryAfterMs?: number;
  resetAt?: string;
  /** BOOK-111: the filing a duplicate refusal names, for the «открыть отправленное» door. */
  commentId?: string;
  /** BOOK-158: when the day's attempts come back (the next 00:00 UTC), with either cap. */
  reopenAt?: string;
};

/** A server line may be shown as a detail only when it is the reader's language, never a code. */
function russianDetail(message: string): string | null {
  return /\p{Script=Cyrillic}/u.test(message) ? message : null;
}

/**
 * One public line per refusal code the POST route can answer, plus the transport fallback.
 * BOOK-111: the table is audited against the route's own codes — `INVALID`, `TOO_LONG`,
 * `DUPLICATE`, `STALE_ANCHOR`, `RATE_LIMITED`, `EDIT_DAILY_LIMIT`, `QUEUE_FULL`,
 * `ENDING_FROZEN`, `FROZEN_FRAME`, `BLOCKED`, `UNAUTHENTICATED`, `CAPTCHA_UNAVAILABLE`,
 * `CAPTCHA_FAILED`, `INTERNAL`, `ORIGIN`, `CONTENT_TYPE` — so no code reaches the reader as
 * a raw token, and every line is a Russian sentence even when the message is `Internal Server
 * Error` or the code is a bare `HTTP_500`.
 *
 * BOOK-158 — the revise route's own codes travel here too (`REVISE_COOLDOWN`,
 * `ATTEMPTS_EXHAUSTED`, `ATTEMPT_LIMIT`, `IDENTICAL`, `NOT_REVISABLE`, `NOT_FOUND`): a refusal
 * to revise is the same strip's line as a refusal to post, with the wait it owes the reader.
 */
export function errorCopy(error: ComposerError): RefusalCopy {
  const reset = error.resetAt === undefined ? null : `до ${formatReset(error.resetAt)}`;
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return { line: SIGNIN_LINES.chapter, detail: null, canRetry: false };
    case 'RATE_LIMITED':
      return { line: 'слишком много замечаний — попробуйте позже', detail: reset, canRetry: true };
    case 'EDIT_DAILY_LIMIT':
      return { line: 'одна правка в сутки — сегодня уже была', detail: reset, canRetry: false };
    case 'DUPLICATE':
      // The line the reader needs first: their filing exists. The door to it sits beside it.
      return { line: 'такое замечание уже отправлено', detail: null, canRetry: false };
    case 'STALE_ANCHOR':
      return { line: 'абзац изменился — привяжите замечание заново', detail: null, canRetry: true };
    // BOOK-158 — the revise route's refusals. Its sentences are written for the reader, so the
    // server's own line is printed when it is Russian; the local line is the fallback for a
    // message this build cannot read (a proxy's, an older server's).
    case 'REVISE_COOLDOWN':
      return {
        line: russianDetail(error.message) ?? 'слишком быстро — попробуйте ещё раз чуть позже',
        detail: retryCopy(error.retryAfterMs),
        canRetry: true,
      };
    case 'ATTEMPTS_EXHAUSTED':
      return {
        line: russianDetail(error.message) ?? 'исчерпаны попытки — в следующий раз',
        detail: reopenCopy(error.reopenAt),
        canRetry: false,
      };
    case 'ATTEMPT_LIMIT':
      return {
        line: russianDetail(error.message) ?? 'слишком много попыток сегодня — попробуйте завтра',
        detail: reopenCopy(error.reopenAt),
        canRetry: false,
      };
    case 'IDENTICAL':
      return {
        line: russianDetail(error.message) ?? 'это уже было — поправьте формулировку',
        detail: null,
        canRetry: true,
      };
    case 'NOT_REVISABLE':
      return {
        line: russianDetail(error.message) ?? 'это замечание уже поправлено',
        detail: null,
        canRetry: false,
      };
    case 'NOT_FOUND':
      return { line: 'замечание не найдено — обновите страницу', detail: null, canRetry: false };
    case 'QUEUE_FULL':
      return { line: 'очередь правок заполнена — попробуйте позже', detail: retryCopy(error.retryAfterMs), canRetry: true };
    case 'ENDING_FROZEN':
      return { line: 'финал заморожен: правка читателя туда не входит', detail: null, canRetry: false };
    case 'FROZEN_FRAME':
      return { line: PREMISE_FROZEN_REASON, detail: null, canRetry: false };
    case 'BLOCKED':
      return { line: 'замечания от этого автора не принимаются', detail: null, canRetry: false };
    case 'INVALID':
      return {
        line: 'замечание не отправлено — проверьте поля',
        detail: russianDetail(error.message),
        canRetry: true,
      };
    case 'TOO_LONG':
      return { line: 'текст длиннее допустимого — сократите его', detail: null, canRetry: true };
    case 'CAPTCHA_UNAVAILABLE':
      return { line: 'проверка сейчас недоступна — попробуйте позже', detail: retryCopy(error.retryAfterMs), canRetry: true };
    case 'CAPTCHA_FAILED':
      return { line: 'проверка не пройдена — попробуйте ещё раз', detail: null, canRetry: true };
    case 'ORIGIN':
      return { line: 'страница устарела — обновите её и попробуйте снова', detail: null, canRetry: true };
    case 'CONTENT_TYPE':
      return { line: 'страница устарела — обновите её и попробуйте снова', detail: null, canRetry: true };
    case 'INTERNAL':
      return { line: 'сервер не ответил — попробуйте позже', detail: null, canRetry: true };
    default:
      // A bare `HTTP_500` or a code this build does not know: the reader gets the sentence,
      // and the server's own Russian line only as a detail.
      return {
        line: 'не удалось отправить замечание — попробуйте ещё раз',
        detail: russianDetail(error.message),
        canRetry: true,
      };
  }
}

/**
 * The codes whose line names no filing kind at all — «очередь правок заполнена», «финал
 * заморожен» — so a premise keeps the chapter's own words instead of a second copy of them.
 */
const SURFACE_NEUTRAL_CODES: ReadonlySet<string> = new Set([
  'TOO_LONG',
  'EDIT_DAILY_LIMIT',
  'QUEUE_FULL',
  'ENDING_FROZEN',
  'FROZEN_FRAME',
  'CAPTCHA_UNAVAILABLE',
  'CAPTCHA_FAILED',
  'ORIGIN',
  'CONTENT_TYPE',
  'INTERNAL',
]);

/**
 * BOOK-84 — the one place a refusal becomes words for the surface it answers, and the form's
 * only call: `errorCopy` stays the chapter's table, and a **premise** — an empty chapter, the
 * draft's `blockId === null` — replaces the lines that call the filing a «замечание». The strip
 * above the form says «это замысел главы, а не замечание к тексту»; a refusal that said
 * otherwise was the one place the page still contradicted itself.
 *
 * Every line holds its own truth: a duplicate is still a duplicate («у главы уже есть замысел»),
 * and its number is the one the refusal itself names — `commentId`, the row the door opens, never
 * a premise the page happens to hold — so the line and the door can not point at two rows. The
 * signed-out gate asks to sign in **for the act the form performs** — a premise, not a remark.
 * A written chapter keeps its own wording exactly.
 */
export function refusalCopy(error: ComposerError, surface: RefusalSurface): RefusalCopy {
  const copy = errorCopy(error);
  if (surface === 'chapter') return copy;
  const premise = premiseWords(error, copy);
  // A premise's detail is the server's own sentence too: a message that calls the filing a
  // «замечание» is dropped rather than printed under the word «замысел». The form's own
  // too-short line already names the act, so nothing the reader needs is lost.
  return { ...premise, detail: premiseDetail(premise.detail) };
}

/** The premise's wording, one case per line that names the filing; the rest are the chapter's. */
function premiseWords(error: ComposerError, copy: RefusalCopy): RefusalCopy {
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return { ...copy, line: SIGNIN_LINES.premise };
    case 'RATE_LIMITED':
      return { ...copy, line: 'слишком много замыслов — попробуйте позже' };
    case 'DUPLICATE': {
      // The first premise is the filing the refusal names — one source for the number and the door.
      const first = premiseRefusal(error.commentId ?? null);
      return { ...copy, line: first.line, detail: first.detail };
    }
    case 'INVALID':
      return { ...copy, line: 'замысел не отправлен — проверьте поля' };
    case 'BLOCKED':
      return { ...copy, line: 'замыслы от этого автора не принимаются' };
    case 'STALE_ANCHOR':
      // A premise carries no anchor, so this cannot reach one; the line is here so that no
      // surface table can put a «замечание» under an empty chapter.
      return { ...copy, line: 'абзац изменился — привяжите заново' };
    // BOOK-158 revises a filing by its id, and a premise is such a filing: its own card offers
    // «исправить», so these two codes can answer under an empty chapter. The chapter's lines say
    // «замечание» — the premise's say «замысел», which is what its row is called.
    case 'NOT_REVISABLE':
      return { ...copy, line: 'этот замысел уже поправлен' };
    case 'NOT_FOUND':
      return { ...copy, line: 'замысел не найден — обновите страницу' };
    // The revise route's waits are written by the server, and its sentence may call the filing a
    // «замечание»: a premise prints the code's own fallback instead, which names no kind at all.
    case 'REVISE_COOLDOWN':
    case 'ATTEMPTS_EXHAUSTED':
    case 'ATTEMPT_LIMIT':
    case 'IDENTICAL':
      return { ...copy, line: codeLine(error) };
    default:
      // A code this build does not know still owes the premise its own word.
      return SURFACE_NEUTRAL_CODES.has(error.code)
        ? copy
        : { ...copy, line: 'не удалось отправить замысел — попробуйте ещё раз' };
  }
}

/** A premise's detail may not call the filing what the strip denied it is. */
function premiseDetail(detail: string | null): string | null {
  return detail === null || /замечани/iu.test(detail) ? null : detail;
}

/**
 * A code's own sentence, with the server's message left out: `errorCopy` echoes a Russian
 * message into the line, and that echo is the one thing a premise may not print.
 */
function codeLine(error: ComposerError): string {
  return errorCopy({ ...error, message: '' }).line;
}

/** «осталось 7 из 10 за час · правок сегодня 0 из 1» — the limit is never a surprise. */
export function budgetLine(budget: CommentBudget): string {
  // BOOK-113: an exempt identity has no daily counter to show, so the line says so instead of
  // printing «1 из 1» for a limit that does not apply to them.
  if (budget.editsExempt === true) {
    return `осталось ${budget.remaining} из ${budget.perHour} за час · правки без дневного ограничения`;
  }
  return `осталось ${budget.remaining} из ${budget.perHour} за час · правок сегодня ${budget.editsRemaining} из ${budget.editsPerDay}`;
}

export function retryCopy(retryAfterMs: number | undefined): string | null {
  if (retryAfterMs === undefined || retryAfterMs <= 0) return null;
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return minutes >= 60 ? `примерно через ${Math.ceil(minutes / 60)} ч` : `примерно через ${minutes} мин`;
}

function formatReset(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'позже';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * BOOK-158 — when the day's attempts come back: the refusal carries the next 00:00 UTC, and
 * the reader's own clock prints it. A missing or unreadable time says nothing at all, rather
 * than inventing an hour.
 */
function reopenCopy(iso: string | undefined): string | null {
  return iso === undefined ? null : `попытки вернутся в ${formatReset(iso)}`;
}

/**
 * BOOK-DOC-4 rule 1 — the composer mirrors the server: both caps arrive in `hello`, which
 * is built from the shared constants. No number is typed into the markup, so the counter
 * and `maxLength` can never drift from the guard that will judge the draft.
 */
export function draftLimits(composer: ComposerInfo): { body: number; edit: number } {
  return { body: composer.maxChars, edit: composer.editMaxChars };
}

/** «137 / 10 000» — one shape for both fields, so the bound is visible while writing. */
export function counterLabel(length: number, max: number): string {
  return `${length} / ${max}`;
}

/**
 * The draft's own line: what the reader is about to bring into the book. A kind is never
 * pre-selected — until the reader picks one, the line says so.
 */
export function draftKindLine(kind: InterventionKind | null): string {
  return kind === null
    ? 'тип не выбран — без него правка не уйдёт'
    : `вносится: ${INTERVENTION_KIND_LABELS[kind]}`;
}
