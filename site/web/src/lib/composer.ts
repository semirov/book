import type { CommentBudget, ComposerInfo, InterventionKind, ViewerDto } from '@book/shared';
import {
  COMMENT_MAX_CHARS,
  COMMENT_MIN_CHARS,
  EDIT_MAX_CHARS,
  INTERVENTION_KIND_LABELS,
  validateInterventionKind,
} from '@book/shared';

/**
 * BOOK-DOC-4 rule 1 — before `hello` arrives the composer shows the same caps the server
 * will confirm, taken from the shared constants rather than from a local copy.
 */
export const EMPTY_COMPOSER: ComposerInfo = {
  captcha: { provider: 'none', siteKey: null },
  minChars: COMMENT_MIN_CHARS,
  maxChars: COMMENT_MAX_CHARS,
  editMaxChars: EDIT_MAX_CHARS,
};

/**
 * The composer's decisions, separated from its markup (§11.6, §12.8).
 *
 * The composer is the only place where a reader can write, so the states are explicit and
 * tested: signed out, closed because the verifier is unreachable, ready, refused with a
 * reason, sent. Nothing here decides whether a comment is *allowed* — that is the server's
 * guard — it only tells the reader the truth about what just happened.
 */

export type ComposerError = {
  code: string;
  message: string;
  retryAfterMs?: number;
  resetAt?: string;
};

export type ComposerView =
  | { kind: 'signin'; line: string; detail: string | null }
  | { kind: 'closed'; line: string; detail: string | null }
  | { kind: 'sent'; line: string; detail: string | null }
  | { kind: 'ready'; detail: string | null }
  | { kind: 'refused'; line: string; detail: string | null; canRetry: boolean };

const CLOSED_LINE = 'приём замечаний приостановлен · проверка недоступна';
const SIGNIN_LINE = 'войдите через Яндекс, чтобы оставить замечание';

/** A verifier that is missing, unconfigured or unreachable closes the composer (§12.8). */
export function isComposerClosed(error: ComposerError | null, composer: ComposerInfo): boolean {
  if (composer.captcha.provider === 'none' || composer.captcha.siteKey === null) return true;
  return error?.code === 'CAPTCHA_UNAVAILABLE';
}

export function composerView(input: {
  viewer: ViewerDto;
  composer: ComposerInfo;
  error: ComposerError | null;
  sent: boolean;
  budget: CommentBudget | null;
}): ComposerView {
  const { viewer, composer, error, sent, budget } = input;
  if (isComposerClosed(error, composer)) {
    return { kind: 'closed', line: CLOSED_LINE, detail: 'замечания откроются, когда проверка вернётся' };
  }
  if (!viewer.signedIn) {
    return { kind: 'signin', line: SIGNIN_LINE, detail: 'читателям без входа доступно чтение' };
  }
  if (error !== null) {
    const copy = errorCopy(error);
    return { kind: 'refused', ...copy };
  }
  if (sent) {
    return { kind: 'sent', line: 'замечание записано', detail: budget === null ? null : budgetLine(budget) };
  }
  return {
    kind: 'ready',
    detail: budget === null ? null : budgetLine(budget),
  };
}

/** One public line per refusal code; the server's message is a fallback, never a secret. */
export function errorCopy(error: ComposerError): { line: string; detail: string | null; canRetry: boolean } {
  const reset = error.resetAt === undefined ? null : `до ${formatReset(error.resetAt)}`;
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return { line: SIGNIN_LINE, detail: null, canRetry: false };
    case 'CAPTCHA_FAILED':
      return { line: 'проверка не пройдена — попробуйте ещё раз', detail: null, canRetry: true };
    case 'CAPTCHA_UNAVAILABLE':
      return { line: CLOSED_LINE, detail: null, canRetry: false };
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
 * Client-side check before a request: cheap, honest, and never the last word.
 *
 * BOOK-16: an intervention (a proposed wording) needs one of the four kinds before it is
 * sent. The refusal line is the shared validator's own, so the composer, the API and the
 * CLI say the same sentence about the same omission.
 */
export function validateDraft(input: {
  body: string;
  proposed: string;
  kind: InterventionKind | null;
  composer: ComposerInfo;
  captchaToken: string | null;
}):
  | { ok: true; body: string; proposed: string | null; kind: InterventionKind | null }
  | { ok: false; line: string } {
  const body = input.body.trim();
  if (body.length < input.composer.minChars) return { ok: false, line: `замечание короче ${input.composer.minChars} символов` };
  if (body.length > input.composer.maxChars) return { ok: false, line: `замечание длиннее ${input.composer.maxChars} символов` };
  if (input.captchaToken === null || input.captchaToken.length === 0) {
    return { ok: false, line: 'подтвердите, что вы не робот' };
  }
  const proposed = input.proposed.trim();
  if (proposed.length > input.composer.editMaxChars) {
    return { ok: false, line: `правка длиннее ${input.composer.editMaxChars} символов` };
  }
  if (proposed.length > 0 && proposed.length < input.composer.minChars) {
    return { ok: false, line: `правка короче ${input.composer.minChars} символов` };
  }
  if (proposed.length === 0) {
    // A chosen kind with nothing to carry it must not be dropped in silence: an intervention
    // is its wording *and* its kind, so an empty wording is the short-wording refusal.
    if (input.kind !== null) return { ok: false, line: `правка короче ${input.composer.minChars} символов` };
    return { ok: true, body, proposed: null, kind: null };
  }
  const kind = validateInterventionKind(input.kind);
  if (!kind.ok) return { ok: false, line: kind.reason };
  return { ok: true, body, proposed, kind: kind.kind };
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
