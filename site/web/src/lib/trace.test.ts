import type { MyTraceDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { traceLine } from './trace.ts';

/**
 * The reader's own trace sentence, moved out of the end matter (BOOK-207) and rewritten so it
 * says what it measures (BOOK-221): since which measured day, how often the chapters were
 * rewritten, what the share is a share **of** — and, at zero, that there is nothing to share.
 */
function trace(overrides: Partial<MyTraceDto> = {}): MyTraceDto {
  return {
    label: 'Аня',
    edits: 3,
    chars: 4_000,
    share: 0.004,
    series: [],
    hidden: false,
    isAuthor: false,
    survivedRevisions: 4,
    ...overrides,
  };
}

/** `4 000 знаков`: the number, the site's non-breaking space and the noun with its plural. */
const CHARS = '4\u00a0000\u00a0знаков';

describe('the reader’s own trace line', () => {
  it('names the first measured day, the rewrites since, and what the share is a share of', () => {
    const line = traceLine(
      trace({
        share: 0.011,
        survivedRevisions: 12,
        series: [{ day: '2026-10-12', edits: 3, chars: 4_000, share: 0.011 }],
      }),
    );
    expect(line).toBe(
      `ваши слова в книге с 12.10: главы с тех пор правили 12 раз, а слова остались. сейчас это 1,1 % текста книги — ${CHARS}.`,
    );
    // The percent is never bare: it always names its whole.
    expect(line).toContain('% текста книги');
    expect(line).not.toMatch(/\d %(?! текста книги)/u);
    expect(line).not.toContain('0.011');
  });

  it('drops the day clause when no day was measured, and keeps the rest', () => {
    expect(traceLine(trace())).toBe(
      `ваши слова в книге: главы правили 4 раза, а слова остались. сейчас это 0,4 % текста книги — ${CHARS}.`,
    );
  });

  it('counts the rewrites in Russian, never «4 раз»', () => {
    const times = (survivedRevisions: number): string =>
      traceLine(trace({ survivedRevisions })).split(': ')[1]?.split(', ')[0] ?? '';
    expect(times(1)).toBe('главы правили 1 раз');
    expect(times(2)).toBe('главы правили 2 раза');
    expect(times(4)).toBe('главы правили 4 раза');
    expect(times(5)).toBe('главы правили 5 раз');
    expect(times(11)).toBe('главы правили 11 раз');
    expect(times(21)).toBe('главы правили 21 раз');
    expect(times(22)).toBe('главы правили 22 раза');
  });

  it('skips the day the reader had no words in the book: a queued-only point is not a start', () => {
    // `measureContributions` writes a 0-character point for an identity that only queued a change,
    // so `series[0]` can be a day their words were nowhere in the text. The sentence names the
    // first day that actually carries characters.
    const line = traceLine(
      trace({
        series: [
          { day: '2026-10-09', edits: 1, chars: 0, share: 0 },
          { day: '2026-10-12', edits: 1, chars: 4_000, share: 0.004 },
        ],
      }),
    );
    expect(line).toContain('ваши слова в книге с 12.10:');
    expect(line).not.toContain('09.10');
  });

  it('drops the day clause when no measured point ever held a character', () => {
    const line = traceLine(trace({ series: [{ day: '2026-10-09', edits: 1, chars: 0, share: 0 }] }));
    expect(line).toContain('ваши слова в книге: главы правили 4 раза');
    expect(line).not.toContain('09.10');
  });

  it('says the words are there and untouched, not «0 ревизий»', () => {
    const line = traceLine(
      trace({ survivedRevisions: 0, series: [{ day: '2026-10-12', edits: 3, chars: 4_000, share: 0.004 }] }),
    );
    expect(line).toBe(
      `ваши слова в книге с 12.10: их ещё не переписывали. сейчас это 0,4 % текста книги — ${CHARS}.`,
    );
    expect(line).not.toContain('ревизи');
    expect(line).not.toContain('правили 0');
  });

  it('prints the truthful zero line, never «0,0 %»', () => {
    expect(traceLine(trace({ share: 0, chars: 0 }))).toBe('ваших слов в книге сейчас нет');
    expect(traceLine(trace({ share: 0, chars: 0 }))).not.toContain('%');
  });

  it('prints the share with a Russian decimal comma, not a dot', () => {
    expect(traceLine(trace({ share: 0.1234 }))).toContain('12,3 %');
    expect(traceLine(trace({ share: 0.1234 }))).not.toContain('12.3');
  });
});
