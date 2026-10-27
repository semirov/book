import type { CommentBudget, ComposerInfo, InterventionKind } from '@book/shared';
import {
  COMMENT_MAX_CHARS,
  COMMENT_MIN_CHARS,
  EDIT_MAX_CHARS,
  INTERVENTION_KIND_LABELS,
  PREMISE_FROZEN_REASON,
} from '@book/shared';

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

/** The line a signed-out form shows; `errorCopy` and the form share it. */
const SIGNIN_LINE = 'войдите через Яндекс, чтобы оставить замечание';

export type ComposerError = {
  code: string;
  message: string;
  retryAfterMs?: number;
  resetAt?: string;
};

/** One public line per refusal code; the server's message is a fallback, never a secret. */
export function errorCopy(error: ComposerError): { line: string; detail: string | null; canRetry: boolean } {
  const reset = error.resetAt === undefined ? null : `до ${formatReset(error.resetAt)}`;
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return { line: SIGNIN_LINE, detail: null, canRetry: false };
    case 'RATE_LIMITED':
      return { line: 'слишком много замечаний — попробуйте позже', detail: reset, canRetry: true };
    case 'EDIT_DAILY_LIMIT':
      return { line: 'одна правка в сутки — сегодня уже была', detail: reset, canRetry: false };
    case 'DUPLICATE':
      return { line: 'такое замечание уже отправлено', detail: null, canRetry: false };
    case 'STALE_ANCHOR':
      return { line: 'абзац изменился — привяжите замечание заново', detail: null, canRetry: true };
    case 'QUEUE_FULL':
      return { line: 'очередь правок заполнена — попробуйте позже', detail: retryCopy(error.retryAfterMs), canRetry: true };
    case 'ENDING_FROZEN':
      return { line: 'финал заморожен: правка читателя туда не входит', detail: null, canRetry: false };
    case 'FROZEN_FRAME':
      return { line: PREMISE_FROZEN_REASON, detail: null, canRetry: false };
    case 'BLOCKED':
      return { line: 'замечания от этого автора не принимаются', detail: null, canRetry: false };
    default:
      return { line: error.message.length > 0 ? error.message : 'не удалось отправить замечание', detail: null, canRetry: true };
  }
}

/** «осталось 7 из 10 за час · правок сегодня 0 из 1» — the limit is never a surprise. */
export function budgetLine(budget: CommentBudget): string {
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
