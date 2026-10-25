import type { CommentBudget, ComposerInfo, ViewerDto } from '@book/shared';

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

/** Client-side check before a request: cheap, honest, and never the last word. */
export function validateDraft(input: {
  body: string;
  proposed: string;
  composer: ComposerInfo;
  captchaToken: string | null;
}): { ok: true; body: string; proposed: string | null } | { ok: false; line: string } {
  const body = input.body.trim();
  if (body.length < input.composer.minChars) return { ok: false, line: `замечание короче ${input.composer.minChars} символов` };
  if (body.length > input.composer.maxChars) return { ok: false, line: `замечание длиннее ${input.composer.maxChars} символов` };
  if (input.captchaToken === null || input.captchaToken.length === 0) {
    return { ok: false, line: 'подтвердите, что вы не робот' };
  }
  const proposed = input.proposed.trim();
  return { ok: true, body, proposed: proposed.length === 0 ? null : proposed };
}
