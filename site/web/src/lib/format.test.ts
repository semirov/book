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
  const now = new Date('2026-10-25T12:00:00Z');

  it('says the book begins on day one', () => {
    expect(chipCopy({ count: 0, lastChangeAt: null }, now)).toEqual({ text: 'книга начинается', live: false });
  });

  it('says there is no entry when a chapter has no timestamp', () => {
    expect(chipCopy({ count: 3, lastChangeAt: null }, now)).toEqual({ text: 'записи нет', live: false });
  });

  it('counts minutes under an hour', () => {
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T11:59:30Z' }, now).text).toBe(
      'последняя запись · только что',
    );
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T11:59:00Z' }, now).text).toBe(
      'последняя запись · 1 минуту назад',
    );
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T11:57:00Z' }, now).text).toBe(
      'последняя запись · 3 минуты назад',
    );
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T11:01:00Z' }, now).text).toBe(
      'последняя запись · 59 минут назад',
    );
  });

  it('shows the clock between one and six hours', () => {
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T10:30:00Z' }, now).text).toBe('последняя запись · 13:30');
  });

  it('says silence after six hours, never "offline"', () => {
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T06:00:00Z' }, now).text).toBe('тишина с 09:00');
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-22T06:00:00Z' }, now).text).toBe('тишина с 22.10');
  });

  it('never claims liveness without an engine', () => {
    expect(chipCopy({ count: 3, lastChangeAt: '2026-10-25T11:59:00Z' }, now).live).toBe(false);
    expect(chipCopy({ count: 0, lastChangeAt: null }, now).live).toBe(false);
  });
});

describe('queueLabel', () => {
  it('states the queue as a fact', () => {
    expect(queueLabel(0)).toBe('замечаний нет');
    expect(queueLabel(1)).toBe('1 замечание');
    expect(queueLabel(4)).toBe('4 замечания');
    expect(queueLabel(11)).toBe('11 замечаний');
  });
});
