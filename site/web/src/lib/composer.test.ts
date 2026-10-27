import { describe, expect, it } from 'vitest';

import {
  draftKindLine,
  errorCopy,
  retryCopy,
} from './composer.ts';

describe('the form’s bounds and refusals (§11.6, §12.8)', () => {
  it('maps every refusal code to one Russian line, never to a server internal', () => {
    const cases: Array<[string, string, boolean]> = [
      ['UNAUTHENTICATED', 'Яндекс', false],
      ['CAPTCHA_FAILED', 'проверка', true],
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

  it('shows a reset moment and a human retry estimate', () => {
    const copy = errorCopy({ code: 'RATE_LIMITED', message: '', resetAt: '2026-10-25T13:04:11Z' });
    expect(copy.detail).toMatch(/^до \d{2}:\d{2}$/u);
    expect(retryCopy(90_000)).toBe('примерно через 2 мин');
    expect(retryCopy(3_600_000)).toBe('примерно через 1 ч');
    expect(retryCopy(undefined)).toBeNull();
  });

  it('says in the draft state what is being brought, and that nothing is chosen yet', () => {
    expect(draftKindLine(null)).toBe('тип не выбран — без него правка не уйдёт');
    expect(draftKindLine('decision')).toBe('вносится: решение героя');
  });
});
