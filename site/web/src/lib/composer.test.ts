import { describe, expect, it } from 'vitest';

import {
  budgetLine,
  draftKindLine,
  errorCopy,
  refusalCopy,
  retryCopy,
  signinCopy,
} from './composer.ts';

describe('a premise’s refusals are the premise’s words (BOOK-84)', () => {
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
    'TOO_SHORT',
    'HTTP_500',
    // BOOK-158's revise route answers here too: a premise's card offers «исправить», so a
    // refusal to revise that filing lands under the same strip.
    'REVISE_COOLDOWN',
    'ATTEMPTS_EXHAUSTED',
    'ATTEMPT_LIMIT',
    'IDENTICAL',
    'NOT_REVISABLE',
    'NOT_FOUND',
  ];

  it('never calls an empty chapter’s filing a «замечание», on any code — line or detail', () => {
    // The strip says «это замысел главы, а не замечание к тексту»; the refusal below it may not
    // deny that sentence, whatever the server answered. The message here is the server’s own
    // Russian sentence *with* the note word in it, so a leaking detail is caught too — a written
    // chapter still prints that same message as its detail below.
    for (const code of codes) {
      const error = { code, message: 'замечание короче 3 символов' };
      const copy = refusalCopy(error, 'premise');
      expect(copy.line, code).not.toMatch(/замечани/iu);
      expect(copy.line, code).toMatch(/\p{Script=Cyrillic}/u);
      expect(copy.detail ?? '', code).not.toMatch(/замечани/iu);
    }
  });

  it('keeps a written chapter’s wording exactly as it was', () => {
    for (const code of codes) {
      const error = { code, message: 'замечание короче 3 символов' };
      expect(refusalCopy(error, 'chapter'), code).toEqual(errorCopy(error));
    }
    expect(refusalCopy({ code: 'DUPLICATE', message: '' }, 'chapter').line).toBe('такое замечание уже отправлено');
    // The chapter keeps the server’s Russian sentence as its detail, note word and all.
    expect(refusalCopy({ code: 'INVALID', message: 'замечание короче 3 символов' }, 'chapter').detail).toBe(
      'замечание короче 3 символов',
    );
  });

  it('names the premise the refusal itself points at — one row for the line and the door', () => {
    // The prod 409: the reader’s own premise already exists. The number comes from the 409’s own
    // `commentId`, the row the door opens, so a stale page cannot name one row and open another.
    const error = { code: 'DUPLICATE', message: 'такое замечание уже отправлено', commentId: 'cmt_1' };
    expect(refusalCopy(error, 'premise')).toEqual({
      line: 'у главы уже есть замысел',
      detail: 'первый замысел — №MT1',
      canRetry: false,
    });
    // A 409 with no id still says the chapter holds a premise; it just cannot name it.
    expect(refusalCopy({ code: 'DUPLICATE', message: '' }, 'premise')).toMatchObject({
      line: 'у главы уже есть замысел',
      detail: null,
    });
  });

  it('asks a signed-out reader for the act the form would perform', () => {
    expect(signinCopy('premise')).toEqual({
      line: 'войдите через Яндекс, чтобы заложить замысел',
      fine: 'Читать можно без входа. Автор замысла виден другим читателям.',
    });
    expect(signinCopy('chapter').line).toBe('войдите через Яндекс, чтобы оставить замечание');
    // The refusal code and the visible gate are one table, so they cannot drift.
    expect(refusalCopy({ code: 'UNAUTHENTICATED', message: '' }, 'premise').line).toBe(signinCopy('premise').line);
  });

  it('keeps the lines that name no filing kind, and speaks of замыслы under the rate limit', () => {
    expect(refusalCopy({ code: 'QUEUE_FULL', message: '', retryAfterMs: 60_000 }, 'premise')).toEqual(
      errorCopy({ code: 'QUEUE_FULL', message: '', retryAfterMs: 60_000 }),
    );
    expect(refusalCopy({ code: 'RATE_LIMITED', message: '' }, 'premise').line).toBe(
      'слишком много замыслов — попробуйте позже',
    );
    expect(refusalCopy({ code: 'INVALID', message: 'замысел короче 3 символов' }, 'premise')).toMatchObject({
      line: 'замысел не отправлен — проверьте поля',
      detail: 'замысел короче 3 символов',
    });
  });

  /**
   * BOOK-158 revisits a premise too: its own card offers «исправить», so the revise route's
   * refusals can answer under an empty chapter. They keep their own truth — the wait is still a
   * wait — and drop only the server's sentence when it calls the filing a «замечание».
   */
  it('keeps the revise route’s lines on a premise without its «замечание»', () => {
    const server = 'замечание уже поправлено';
    expect(refusalCopy({ code: 'REVISE_COOLDOWN', message: server }, 'premise')).toMatchObject({
      line: 'слишком быстро — попробуйте ещё раз чуть позже',
    });
    expect(refusalCopy({ code: 'NOT_REVISABLE', message: server }, 'premise')).toMatchObject({
      line: 'этот замысел уже поправлен',
      detail: null,
    });
    expect(refusalCopy({ code: 'NOT_FOUND', message: server }, 'premise').line).toBe(
      'замысел не найден — обновите страницу',
    );
    // A wait is still a wait on either surface; only the echoed sentence is dropped.
    expect(refusalCopy({ code: 'ATTEMPT_LIMIT', message: server }, 'premise').line).toBe(
      'слишком много попыток сегодня — попробуйте завтра',
    );
  });
});

describe('the form’s bounds and refusals (§11.6, §12.8)', () => {
  it('maps every refusal code to one Russian line, never to a server internal', () => {
    const cases: Array<[string, string, boolean]> = [
      ['UNAUTHENTICATED', 'Яндекс', false],
      ['RATE_LIMITED', 'слишком много', true],
      ['EDIT_DAILY_LIMIT', 'одна правка в сутки', false],
      ['DUPLICATE', 'уже отправлено', false],
      ['QUEUE_FULL', 'очередь', true],
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
