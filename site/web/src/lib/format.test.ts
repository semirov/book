import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  formatChars,
  formatDate,
  formatFileSize,
  formatNumber,
  formatTime,
  plural,
  queueLabel,
  queueView,
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

/**
 * The queue line and the list come from one fact. The prod register said «в
 * очереди пусто» above two rows it presented as waiting, because the line printed a lane depth
 * the rows had already left (or never entered). BOOK-137: the entries are filings only — a
 * change is an attempt inside its filing's entry, so counting it beside the filing would count
 * one thing twice — and a premise never holds a queue place.
 */
describe('queueView', () => {
  const filing = (id: string, status: CommentDto['status'], premise = false): Pick<CommentDto, 'id' | 'status' | 'premise'> => ({
    id,
    status,
    premise,
  });

  it('counts the entries the page presents as queued, never zero over a waiting one', () => {
    const view = queueView(0, [filing('cmt_9', 'new'), filing('cmt_8', 'applied')]);
    expect(view.count).toBe(1);
    expect(view.rows).toEqual([{ kind: 'filing', id: 'cmt_9' }]);
  });

  it('never counts a premise filing, a landed row or a stopped one', () => {
    const view = queueView(0, [
      filing('cmt_p', 'new', true),
      filing('cmt_a', 'applied'),
      filing('cmt_b', 'rejected'),
    ]);
    expect(view.rows).toEqual([]);
    expect(view.count).toBe(0);
  });

  it('counts one filing with an attempt once: the attempt is not a second row', () => {
    // The filing is accepted and its change is pending: before BOOK-137 that pair printed
    // «в очереди 2 правки» over one entry.
    const view = queueView(0, [filing('cmt_a', 'accepted')]);
    expect(view.rows).toHaveLength(1);
    expect(view.count).toBe(1);
  });

  it('keeps the server’s own depth when the page shows fewer rows than the lane holds', () => {
    // The API pages the thread; the line is about the lane, so a bigger depth still prints.
    expect(queueView(5, []).count).toBe(5);
    expect(queueView(1, [filing('cmt_a', 'new')]).count).toBe(1);
    expect(queueView(3, [filing('cmt_a', 'new'), filing('cmt_b', 'new')]).count).toBe(3);
  });
});
