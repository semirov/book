import { describe, expect, it } from 'vitest';

import {
  formatChars,
  formatDate,
  formatFileSize,
  formatNumber,
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
  });

  it('returns an em dash instead of pretending', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatTime('not-a-date')).toBe('—');
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

describe('formatFileSize', () => {
  it('states megabytes with one comma-marked decimal and never a trailing «,0»', () => {
    expect(formatFileSize(1_500_000)).toBe('1,5 МБ');
    expect(formatFileSize(2_340_000)).toBe('2,3 МБ');
    expect(formatFileSize(1_000_000)).toBe('1 МБ');
    expect(formatFileSize(1_049_000)).toBe('1 МБ');
    expect(formatFileSize(12_049_000)).toBe('12 МБ');
    for (const bytes of [1_000_000, 2_000_000]) {
      expect(formatFileSize(bytes)).not.toContain(',0');
    }
  });

  it('states kilobytes below a megabyte, with a plain space and no fraction', () => {
    expect(formatFileSize(512_000)).toBe('512 КБ');
    expect(formatFileSize(999_400)).toBe('999 КБ');
    expect(formatFileSize(999)).toBe('1 КБ');
    // The boundary belongs to the larger unit: 999 999 rounds to 1 МБ, not to 1000 КБ.
    expect(formatFileSize(999_999)).toBe('1 МБ');
    expect(formatFileSize(512_000)).not.toContain('\u00a0');
  });

  it('never prints a number it was not given', () => {
    expect(formatFileSize(0)).toBe('0 КБ');
    expect(formatFileSize(Number.NaN)).toBe('0 КБ');
    expect(formatFileSize(-1)).toBe('0 КБ');
  });
});
