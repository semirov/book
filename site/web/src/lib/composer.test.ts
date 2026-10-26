import { describe, expect, it } from 'vitest';

import {
  budgetLine,
  composerView,
  counterLabel,
  draftLimits,
  EMPTY_COMPOSER,
  errorCopy,
  isComposerClosed,
  retryCopy,
  validateDraft,
} from './composer.ts';

const composer = {
  captcha: { provider: 'turnstile' as const, siteKey: 'key' },
  minChars: 3,
  maxChars: 1_200,
  editMaxChars: 10_000,
};
const viewer = { signedIn: true, displayName: 'Аня' };
const budget = { perHour: 10, remaining: 7, resetAt: null, editsPerDay: 1, editsRemaining: 0, editsResetAt: null };

describe('composer state (§11.6, §12.8)', () => {
  it('asks for sign-in before offering the form', () => {
    const view = composerView({ viewer: { signedIn: false, displayName: null }, composer, error: null, sent: false, budget: null });
    expect(view).toMatchObject({ kind: 'signin' });
    if (view.kind !== 'signin') return;
    expect(view.line).toContain('Яндекс');
  });

  it('closes when the verifier is unreachable, and says so without a form', () => {
    const view = composerView({
      viewer,
      composer,
      error: { code: 'CAPTCHA_UNAVAILABLE', message: 'server copy' },
      sent: false,
      budget: null,
    });
    expect(view).toMatchObject({ kind: 'closed' });
    if (view.kind !== 'closed') return;
    expect(view.line).toContain('приостановлен');
    expect(isComposerClosed({ code: 'CAPTCHA_UNAVAILABLE', message: '' }, composer)).toBe(true);
  });

  it('closes when no provider is configured at all (fail-closed, not fail-open)', () => {
    const unconfigured = { ...composer, captcha: { provider: 'none' as const, siteKey: null } };
    expect(isComposerClosed(null, unconfigured)).toBe(true);
    expect(composerView({ viewer, composer: unconfigured, error: null, sent: false, budget }).kind).toBe('closed');
    const noSiteKey = { ...composer, captcha: { provider: 'turnstile' as const, siteKey: null } };
    expect(isComposerClosed(null, noSiteKey)).toBe(true);
  });

  it('is ready for a signed-in reader and shows what is left', () => {
    const view = composerView({ viewer, composer, error: null, sent: false, budget });
    expect(view).toMatchObject({ kind: 'ready' });
    if (view.kind !== 'ready') return;
    expect(view.detail).toBe('осталось 7 из 10 за час · правок сегодня 0 из 1');
  });

  it('reports a sent comment once and a stale anchor as retryable', () => {
    expect(composerView({ viewer, composer, error: null, sent: true, budget }).kind).toBe('sent');
    const stale = errorCopy({ code: 'STALE_ANCHOR', message: 'server' });
    expect(stale.canRetry).toBe(true);
    expect(stale.line).toContain('привяжите');
  });

  it('maps every refusal code to one Russian line, never to a server internal', () => {
    const cases: Array<[string, string, boolean]> = [
      ['UNAUTHENTICATED', 'Яндекс', false],
      ['CAPTCHA_FAILED', 'проверка', true],
      ['RATE_LIMITED', 'слишком много', true],
      ['EDIT_DAILY_LIMIT', 'одна правка в сутки', false],
      ['DUPLICATE', 'уже отправлено', false],
      ['QUEUE_FULL', 'очередь', true],
      ['ENDING_FROZEN', 'финал', false],
      ['BLOCKED', 'не принимаются', false],
    ];
    for (const [code, fragment, canRetry] of cases) {
      const copy = errorCopy({ code, message: 'internal detail that must not be shown first' });
      expect(copy.line, code).toContain(fragment);
      expect(copy.canRetry, code).toBe(canRetry);
      expect(copy.line).not.toContain('internal detail');
    }
  });

  it('shows a reset moment and a human retry estimate', () => {
    const copy = errorCopy({ code: 'RATE_LIMITED', message: '', resetAt: '2026-10-25T13:04:11Z' });
    expect(copy.detail).toMatch(/^до \d{2}:\d{2}$/u);
    expect(retryCopy(90_000)).toBe('примерно через 2 мин');
    expect(retryCopy(3_600_000)).toBe('примерно через 1 ч');
    expect(retryCopy(undefined)).toBeNull();
  });

  it('formats the budget line and validates a draft before the request', () => {
    expect(budgetLine(budget)).toContain('7 из 10');
    expect(validateDraft({ body: 'ок', proposed: '', composer, captchaToken: 't' })).toMatchObject({ ok: false });
    expect(validateDraft({ body: 'Хорошая сцена.', proposed: ' ', composer, captchaToken: 't' })).toEqual({
      ok: true,
      body: 'Хорошая сцена.',
      proposed: null,
    });
    expect(validateDraft({ body: 'Хорошая сцена.', proposed: '', composer, captchaToken: null })).toMatchObject({
      ok: false,
      line: 'подтвердите, что вы не робот',
    });
  });

  it('mirrors the server edit bound: a 10 000-character intervention passes, 10 001 is refused', () => {
    const proposed = 'я'.repeat(composer.editMaxChars);
    expect(draftLimits(composer)).toEqual({ body: 1_200, edit: 10_000 });
    expect(counterLabel(proposed.length, composer.editMaxChars)).toBe('10000 / 10000');
    // The pre-`hello` default is the same pair the server confirms, from the shared constants.
    expect(EMPTY_COMPOSER).toMatchObject({ minChars: 3, maxChars: 1_200, editMaxChars: 10_000 });

    expect(validateDraft({ body: 'Хорошая сцена.', proposed, composer, captchaToken: 't' })).toMatchObject({
      ok: true,
      proposed,
    });

    const tooLong = validateDraft({
      body: 'Хорошая сцена.',
      proposed: 'я'.repeat(composer.editMaxChars + 1),
      composer,
      captchaToken: 't',
    });
    expect(tooLong).toMatchObject({ ok: false });
    if (tooLong.ok) return;
    // The composer never promises what the server refuses, and says the same number.
    expect(tooLong.line).toContain('10000');
  });

  it('does not apply the note bound to a proposed wording', () => {
    const long = 'я'.repeat(composer.maxChars + 1);
    expect(validateDraft({ body: 'Хорошая сцена.', proposed: long, composer, captchaToken: 't' })).toMatchObject({
      ok: true,
    });
    expect(validateDraft({ body: long, proposed: '', composer, captchaToken: 't' })).toMatchObject({ ok: false });
  });
});
