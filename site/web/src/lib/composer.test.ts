import { describe, expect, it } from 'vitest';

import {
  budgetLine,
  draftKindLine,
  errorCopy,
  retryCopy,
} from './composer.ts';

describe('the form’s bounds and refusals (§11.6, §12.8)', () => {
  it('maps every refusal code to one Russian line, never to a server internal', () => {
    const cases: Array<[string, string, boolean]> = [
      ['UNAUTHENTICATED', 'Яндекс', false],
      ['RATE_LIMITED', 'слишком много', true],
      ['EDIT_DAILY_LIMIT', 'одна правка в сутки', false],
      ['DUPLICATE', 'уже отправлено', false],
      ['QUEUE_FULL', 'правок ждёт слишком много', true],
      ['ENDING_FROZEN', 'финал', false],
      ['FROZEN_FRAME', 'неподвижна', false],
      ['BLOCKED', 'не принимаются', false],
    ];
    for (const [code, fragment, canRetry] of cases) {
      const copy = errorCopy({ code, message: 'internal detail that must not be shown first' });
      expect(copy.line, code).toContain(fragment);
      expect(copy.canRetry, code).toBe(canRetry);
      expect(copy.line).not.toContain('internal detail');
    }
  });

  it('answers every code the POST route can return with a Russian sentence, never the code (BOOK-111)', () => {
    // The audit the owner's 409 asked for: no code may reach the reader as a raw token, and
    // no transport answer may print an English status line.
    const codes = [
      'INVALID',
      'TOO_LONG',
      'DUPLICATE',
      'STALE_ANCHOR',
      'RATE_LIMITED',
      'EDIT_DAILY_LIMIT',
      'QUEUE_FULL',
      'ENDING_FROZEN',
      'FROZEN_FRAME',
      'BLOCKED',
      'UNAUTHENTICATED',
      'CAPTCHA_UNAVAILABLE',
      'CAPTCHA_FAILED',
      'INTERNAL',
      'ORIGIN',
      'CONTENT_TYPE',
      // BOOK-158 — the revise route's refusals are the same strip's line.
      'REVISE_COOLDOWN',
      'ATTEMPTS_EXHAUSTED',
      'ATTEMPT_LIMIT',
      'IDENTICAL',
      'NOT_REVISABLE',
      'NOT_FOUND',
    ];
    for (const code of codes) {
      const copy = errorCopy({ code, message: 'internal detail that must not be shown first' });
      expect(copy.line.length, code).toBeGreaterThan(0);
      expect(copy.line, code).toMatch(/\p{Script=Cyrillic}/u);
      expect(copy.line, code).not.toContain(code);
      expect(copy.line, code).not.toContain('internal detail');
      expect(copy.detail ?? '', code).not.toContain('internal detail');
    }
    // A bare status fallback is a sentence too: `HTTP_500` used to print `Internal Server Error`.
    const fallback = errorCopy({ code: 'HTTP_500', message: 'Internal Server Error' });
    expect(fallback.line).toBe('не удалось отправить замечание — попробуйте ещё раз');
    expect(fallback.detail).toBeNull();
    expect(fallback.canRetry).toBe(true);
    // A Russian server line is kept as the detail; an English one never is.
    expect(errorCopy({ code: 'INVALID', message: 'замечание короче 3 символов' }).detail).toBe('замечание короче 3 символов');
    expect(errorCopy({ code: 'INVALID', message: 'body must be a string' }).detail).toBeNull();
    expect(errorCopy({ code: 'HTTP_503', message: 'сервис недоступен' }).detail).toBe('сервис недоступен');
  });

  it('shows a reset moment and a human retry estimate', () => {
    const copy = errorCopy({ code: 'RATE_LIMITED', message: '', resetAt: '2026-10-25T13:04:11Z' });
    expect(copy.detail).toMatch(/^до \d{2}:\d{2}$/u);
    expect(retryCopy(90_000)).toBe('примерно через 2 мин');
    expect(retryCopy(3_600_000)).toBe('примерно через 1 ч');
    expect(retryCopy(undefined)).toBeNull();
  });

  it('prints the revise route’s own sentence, with the wait it names (BOOK-158)', () => {
    const cooling = errorCopy({
      code: 'REVISE_COOLDOWN',
      message: 'слишком быстро — попробуйте ещё раз чуть позже',
      retryAfterMs: 300_000,
    });
    // The server's sentence is the line; the wait is the detail beside it.
    expect(cooling.line).toBe('слишком быстро — попробуйте ещё раз чуть позже');
    expect(cooling.detail).toBe('примерно через 5 мин');
    expect(cooling.canRetry).toBe(true);

    const exhausted = errorCopy({
      code: 'ATTEMPTS_EXHAUSTED',
      message: 'исчерпаны попытки — в следующий раз',
      reopenAt: '2026-10-29T00:00:00Z',
    });
    expect(exhausted.line).toBe('исчерпаны попытки — в следующий раз');
    expect(exhausted.detail).toMatch(/^попытки вернутся в \d{2}:\d{2}$/u);
    expect(exhausted.canRetry).toBe(false);
    // No hour named, no hour invented.
    expect(errorCopy({ code: 'ATTEMPTS_EXHAUSTED', message: '' }).detail).toBeNull();

    // The cap across a reader's filings says «завтра», never a countdown to one filing's day —
    // and, since BOOK-158 review m1, the post names the hour the tries come back, as the
    // filing's own `ATTEMPTS_EXHAUSTED` does.
    expect(errorCopy({ code: 'ATTEMPT_LIMIT', message: '' }).line).toBe(
      'слишком много попыток сегодня — попробуйте завтра',
    );
    const capped = errorCopy({
      code: 'ATTEMPT_LIMIT',
      message: 'слишком много попыток сегодня — попробуйте завтра',
      reopenAt: '2026-10-29T00:00:00Z',
    });
    expect(capped.detail).toMatch(/^попытки вернутся в \d{2}:\d{2}$/u);
    expect(capped.canRetry).toBe(false);
    expect(errorCopy({ code: 'IDENTICAL', message: '' }).line).toBe('это уже было — поправьте формулировку');
    expect(errorCopy({ code: 'NOT_REVISABLE', message: '' }).canRetry).toBe(false);
    expect(errorCopy({ code: 'NOT_FOUND', message: '' }).line).toContain('не найдено');
  });

  it('says in the draft state what is being brought, and that nothing is chosen yet', () => {
    expect(draftKindLine(null)).toBe('тип не выбран — без него правка не уйдёт');
    expect(draftKindLine('decision')).toBe('вносится: решение героя');
  });

  it('prints the exempt budget line without a daily counter (BOOK-113)', () => {
    const line = budgetLine({
      perHour: 10,
      remaining: 9,
      resetAt: null,
      editsPerDay: 1,
      editsRemaining: 1,
      editsResetAt: null,
      editsExempt: true,
    });
    expect(line).toBe('осталось 9 из 10 за час · правки без дневного ограничения');
    // Everyone else keeps the exact existing shape.
    expect(
      budgetLine({ perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 0, editsResetAt: null }),
    ).toBe('осталось 9 из 10 за час · правок сегодня 0 из 1');
  });
});
