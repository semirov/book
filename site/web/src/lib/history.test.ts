import type { BookAtDto, CatalogEntry, HistoryRecordDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { NBSP } from './format.ts';
import {
  chainHead,
  compareToNow,
  momentLabel,
  momentParts,
  momentText,
  stepMoment,
} from './history.ts';

function record(overrides: Partial<HistoryRecordDto> = {}): HistoryRecordDto {
  return {
    hseq: 1,
    at: '2026-10-25T09:00:00Z',
    seq: 7,
    chapter: 9,
    premise: false,
    premiseLanded: false,
    alias: 'Аня',
    status: 'done',
    outcome: 'applied',
    reason: null,
    changeId: 'chg_7',
    ...overrides,
  };
}

function catalog(rows: Array<{ n: number; rev: number; title?: string }>): CatalogEntry[] {
  return rows.map((row) => ({
    n: row.n,
    part: 1,
    title: row.title ?? `глава ${row.n}`,
    rev: row.rev,
    chars: 100,
    blocks: 1,
    written: row.rev > 0,
    basis: false,
    writtenAt: row.rev > 0 ? '2026-10-25T09:00:00Z' : null,
    updatedAt: row.rev > 0 ? '2026-10-25T10:00:00Z' : null,
    direction: 'forward',
  }));
}

function pastAt(rows: Array<{ n: number; rev: number; chars?: number; title?: string }>): BookAtDto {
  return {
    hseq: 42,
    at: '2026-10-25T09:20:00Z',
    front: { rev: 3, title: 'Прежнее название', about: 'О чём книга тогда.' },
    chapters: rows.map((row) => ({
      n: row.n,
      rev: row.rev,
      written: row.rev > 0,
      title: row.title ?? (row.rev > 0 ? `глава ${row.n}` : null),
      chars: row.chars ?? (row.rev > 0 ? 100 : 0),
    })),
    lastHseq: 90,
  };
}

/** A dated moment as the control prints it: `25.10.2026 · 12:00`, Moscow, NBSP around ·. */
function at(date: string, time: string): string {
  return `${date}${NBSP}·${NBSP}${time}`;
}

describe('the moment’s readout (BOOK-DOC-50 §2)', () => {
  /** Newest first, as the timeline sends them: 27.10 15:40 · 26.10 09:00 · 21.10 09:12. */
  const items = [
    record({ hseq: 10, at: '2026-10-27T12:40:00Z' }),
    record({ hseq: 7, at: '2026-10-26T06:00:00Z' }),
    record({ hseq: 4, at: '2026-10-21T06:12:00Z' }),
  ];
  const oldest = at('21.10.2026', '09:12');
  /** The log's clock in the fixtures: it sits on the newest record unless a test moves it. */
  const clockAt = items[0]!.at;

  it('prints a date and a time, never a bare time', () => {
    expect(momentText('2026-10-27T12:40:00Z')).toBe(at('27.10.2026', '15:40'));
    // No `at` (an event the log cannot date) is an honest dash, still in the dated shape.
    expect(momentText(null)).toBe(`—${NBSP}·${NBSP}—`);
  });

  it('splits a moment into the two parts it may wrap between', () => {
    const parts = momentParts('2026-10-27T12:40:00Z');
    expect(parts).toEqual({ date: '27.10.2026', clock: `${NBSP}·${NBSP}15:40` });
    // The same string `momentText` prints, only split — never reformatted.
    expect(`${parts.date}${parts.clock}`).toBe(momentText('2026-10-27T12:40:00Z'));
    expect(momentParts(null)).toEqual({ date: '—', clock: `${NBSP}·${NBSP}—` });
  });

  it('at the right edge prints the clock’s moment, here the newest record’s', () => {
    const label = momentLabel(items, 10, 10, false, clockAt);
    expect(label.text).toBe(at('27.10.2026', '15:40'));
    expect(label.isNow).toBe(true);
    // Counted chronologically: the newest of three loaded rows is the third record.
    expect(label.position).toBe(3);
  });

  it('at the right edge prints the log’s own last moment, never the newest record (BOOK-65 M2)', () => {
    // A machine pass moved the clock to hseq 12 at 18:05 MSK; the newest record is still 15:40.
    const label = momentLabel(items, 12, 12, false, '2026-10-27T15:05:00Z');
    expect(label.text).toBe(at('27.10.2026', '18:05'));
    expect(label.isNow).toBe(true);
    // The position still counts loaded records: the newest of three is the third.
    expect(label.position).toBe(3);
  });

  it('falls back to the newest record when the log holds no row at the clock', () => {
    expect(momentLabel(items, 10, 10, false, null).text).toBe(at('27.10.2026', '15:40'));
  });

  it('for a chosen moment prints that record’s date and time', () => {
    const label = momentLabel(items, 7, 10, false, clockAt);
    expect(label.text).toBe(at('26.10.2026', '09:00'));
    expect(label.isNow).toBe(false);
    expect(label.position).toBe(2);
  });

  it('between two records prints the last record at or before the thumb', () => {
    const label = momentLabel(items, 5, 10, false, clockAt);
    expect(label.text).toBe(oldest);
    expect(label.position).toBe(1);
  });

  it('keeps the oldest loaded record at position 1', () => {
    expect(momentLabel(items, 4, 10, false, clockAt).position).toBe(1);
    expect(momentLabel(items, 3, 10, false, clockAt).position).toBe(1);
    expect(momentLabel(items, 9, 10, false, clockAt).position).toBe(2);
  });

  it('says «до …» before the oldest record only when an older page exists', () => {
    const more = momentLabel(items, 0, 10, true, clockAt);
    expect(more.text).toBe(`до${NBSP}${oldest}`);
    expect(more.isNow).toBe(false);
    expect(more.position).toBe(1);
  });

  it('clamps to the oldest record, without «до», when there is no older page', () => {
    const label = momentLabel(items, 0, 10, false, clockAt);
    expect(label.text).toBe(oldest);
    expect(label.position).toBe(1);
  });

  it('has no readout and no counter without records', () => {
    expect(momentLabel([], 0, 0, false, null)).toEqual({ text: '', isNow: false, position: 0 });
  });
});

describe('stepping a moment (§6F.2)', () => {
  it('steps one record left and right without leaving the list', () => {
    const items = [record({ hseq: 3 }), record({ hseq: 7 }), record({ hseq: 12 })];
    expect(stepMoment(items, 12, -1)).toBe(7);
    expect(stepMoment(items, 7, -1)).toBe(3);
    expect(stepMoment(items, 3, -1)).toBe(3);
    expect(stepMoment(items, 7, 1)).toBe(12);
    expect(stepMoment(items, 12, 1)).toBe(12);
    expect(stepMoment([], 4, 1)).toBe(4);
  });
});

describe('what changed since a past moment (§6F.2)', () => {
  it('names the one chapter that moved and compares the first sheet', () => {
    const difference = compareToNow(
      pastAt([
        { n: 9, rev: 1 },
        { n: 10, rev: 0 },
      ]),
      catalog([
        { n: 9, rev: 2 },
        { n: 10, rev: 0 },
      ]),
      3,
    );
    expect(difference.changed).toEqual([9]);
    expect(difference.front).toBe(false);
    expect(difference.notice).toContain('сейчас глава 9 изменена');
    expect(difference.notice).toContain('так книга выглядела в');
  });

  it('summarises several changed chapters and a changed first sheet', () => {
    const difference = compareToNow(
      pastAt([
        { n: 1, rev: 1 },
        { n: 2, rev: 1 },
        { n: 3, rev: 1 },
        { n: 4, rev: 1 },
      ]),
      catalog([
        { n: 1, rev: 2 },
        { n: 2, rev: 2 },
        { n: 3, rev: 2 },
        { n: 4, rev: 2 },
      ]),
      4,
    );
    expect(difference.changed).toEqual([1, 2, 3, 4]);
    expect(difference.front).toBe(true);
    expect(difference.notice).toContain('и ещё 1');
  });

  it('says so when nothing moved', () => {
    const difference = compareToNow(pastAt([{ n: 1, rev: 1 }]), catalog([{ n: 1, rev: 1 }]), 3);
    expect(difference.notice).toContain('с тех пор ничего не изменилось');
  });

  it('shows an unwritten chapter as absent, never as empty prose', () => {
    const state = pastAt([{ n: 5, rev: 0 }]);
    expect(state.chapters[0]?.written).toBe(false);
    expect(state.chapters[0]?.title).toBeNull();
  });
});

describe('the paragraph chain panel (§6F.3)', () => {
  it('says whether the line is still in the text', () => {
    expect(chainHead({ alive: true, chapter: 8 })).toBe('эта строка сейчас в тексте · глава 8');
    expect(chainHead({ alive: false, chapter: 8 })).toBe('эта строка убрана · глава 8');
  });
});
