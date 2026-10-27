import { describe, expect, it } from 'vitest';

import {
  chipCopy,
  formatChars,
  formatDate,
  formatNumber,
  formatShortDate,
  formatTime,
  plural,
  queueLabel,
} from './format.ts';

describe('formatNumber', () => {
  it('groups thousands with non-breaking spaces', () => {
    expect(formatNumber(99410)).toBe('99\u00a0410');
    expect(formatNumber(85856)).toBe('85\u00a0856');
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });
});

describe('plural', () => {
  it('follows the Russian rules', () => {
    const forms = ['знак', 'знака', 'знаков'] as const;
    expect(plural(1, ...forms)).toBe('знак');
    expect(plural(2, ...forms)).toBe('знака');
    expect(plural(4, ...forms)).toBe('знака');
    expect(plural(5, ...forms)).toBe('знаков');
    expect(plural(11, ...forms)).toBe('знаков');
    expect(plural(12, ...forms)).toBe('знаков');
    expect(plural(21, ...forms)).toBe('знак');
    expect(plural(111, ...forms)).toBe('знаков');
    expect(plural(0, ...forms)).toBe('знаков');
  });
});

describe('formatChars', () => {
  it('adds the right unit', () => {
    expect(formatChars(9003)).toBe('9\u00a0003\u00a0знака');
    expect(formatChars(1)).toBe('1\u00a0знак');
    expect(formatChars(9121)).toBe('9\u00a0121\u00a0знак');
  });
});

describe('times and dates', () => {
  it('renders in the site timezone', () => {
    expect(formatTime('2026-10-25T09:52:00Z')).toBe('12:52');
    expect(formatDate('2026-10-25T09:52:00Z')).toBe('25.10.2026');
    expect(formatShortDate('2026-10-25T09:52:00Z')).toBe('25.10');
  });

  it('returns an em dash instead of pretending', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatTime('not-a-date')).toBe('—');
  });
});

describe('chipCopy', () => {
  const RETIRED = ['книга начинается', 'записи нет', 'тишина с', 'минут назад', 'только что'];

  it('says the book has no chapters yet, with no mood about it', () => {
    expect(chipCopy({ count: 0, lastChangeAt: null })).toEqual({ text: 'глав ещё нет', live: false });
  });

  it('falls to the count of chapters with text when no date can be read', () => {
    // No timestamp is a missing field, not a fact about the book (BOOK-70).
    expect(chipCopy({ count: 3, lastChangeAt: null })).toEqual({ text: '3 главы с текстом', live: false });
    expect(chipCopy({ count: 11, lastChangeAt: null }).text).toBe('11 глав с текстом');
    // An unparseable date is the same missing answer, not «записи нет».
    expect(chipCopy({ count: 3, lastChangeAt: 'not-a-date' })).toEqual({ text: '3 главы с текстом', live: false });
  });

  it('prints the day of the last entry, and never a clock beside the word', () => {
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T09:52:00Z' })).toEqual({
      text: 'последняя запись · 25.10',
      live: false,
    });
    // «последняя запись · 12:52» is a word plus a clock: the cap and the voice rule forbid it.
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T09:52:00Z' }).text).not.toMatch(/\d\d:\d\d/u);
  });

  it('keeps every chip inside the 24-character cap', () => {
    for (const input of [
      { count: 0, lastChangeAt: null },
      { count: 1, lastChangeAt: null },
      { count: 3, lastChangeAt: null },
      { count: 11, lastChangeAt: null },
      { count: 67, lastChangeAt: null },
      { count: 1, lastChangeAt: '2026-10-25T09:52:00Z' },
      { count: 67, lastChangeAt: '2026-12-31T23:59:00Z' },
    ]) {
      expect(chipCopy(input).text.length, chipCopy(input).text).toBeLessThanOrEqual(24);
    }
  });

  it('never claims liveness without an engine, and never uses a retired word', () => {
    for (const input of [
      { count: 0, lastChangeAt: null },
      { count: 3, lastChangeAt: null },
      { count: 3, lastChangeAt: '2026-10-25T11:59:00Z' },
    ]) {
      const chip = chipCopy(input);
      expect(chip.live).toBe(false);
      for (const word of RETIRED) expect(chip.text, word).not.toContain(word);
    }
  });
});

describe('queueLabel', () => {
  it('states the queue as a fact, with the noun it counts', () => {
    expect(queueLabel(0)).toBe('в очереди пусто');
    expect(queueLabel(1)).toBe('в очереди 1 правка');
    expect(queueLabel(4)).toBe('в очереди 4 правки');
    expect(queueLabel(11)).toBe('в очереди 11 правок');
  });

  it('never counts nothing and never says «замечание» — the queue is made of правки', () => {
    for (const depth of [0, 1, 4, 11]) {
      expect(queueLabel(depth)).not.toContain('0 правок');
      expect(queueLabel(depth)).not.toContain('замечан');
    }
  });
});
