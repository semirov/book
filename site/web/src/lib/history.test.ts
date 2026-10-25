import type { BookAtDto, CatalogEntry, HistoryEventDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  chainHead,
  compareToNow,
  filterEvents,
  groupByDay,
  scrubLabel,
  scrubTicks,
  stepMoment,
  targetLabel,
} from './history.ts';

function event(overrides: Partial<HistoryEventDto> = {}): HistoryEventDto {
  return {
    hseq: 1,
    at: '2026-10-25T09:00:00Z',
    kind: 'chapter.created',
    chapter: 9,
    isFront: false,
    rev: 1,
    changeId: null,
    cascadeId: null,
    stepId: null,
    author: { kind: 'writer', identityId: null, label: 'автор' },
    summary: 'глава 9 написана',
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

describe('the chronicle’s filters and grouping (§11.10)', () => {
  it('filters by the four public kinds', () => {
    const items = [
      event({ hseq: 4, kind: 'change.decided', changeId: 'chg_1' }),
      event({ hseq: 3, kind: 'chapter.created' }),
      event({ hseq: 2, kind: 'front.revised', isFront: true, chapter: null }),
      event({ hseq: 1, kind: 'overwrite' }),
    ];
    expect(filterEvents(items, 'all')).toHaveLength(4);
    expect(filterEvents(items, 'changes').map((item) => item.kind)).toEqual(['change.decided']);
    expect(filterEvents(items, 'drafts').map((item) => item.kind)).toEqual(['chapter.created']);
    expect(filterEvents(items, 'front').map((item) => item.kind)).toEqual(['front.revised']);
    expect(filterEvents(items, 'overwrites').map((item) => item.kind)).toEqual(['overwrite']);
  });

  it('groups newest-first events by calendar day and keeps the order inside a day', () => {
    const groups = groupByDay([
      event({ hseq: 9, at: '2026-10-25T12:00:00Z' }),
      event({ hseq: 8, at: '2026-10-25T09:00:00Z' }),
      event({ hseq: 7, at: '2026-10-24T20:00:00Z' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.day).toBe('2026-10-25');
    expect(groups[0]?.items.map((item) => item.hseq)).toEqual([9, 8]);
    expect(groups[1]?.items.map((item) => item.hseq)).toEqual([7]);
    expect(groups[0]?.label).toContain('октября');
  });

  it('labels the target as a chapter, the first sheet or the book', () => {
    expect(targetLabel(event())).toBe('глава 9');
    expect(targetLabel(event({ isFront: true, chapter: null }))).toBe('первая страница');
    expect(targetLabel(event({ chapter: null }))).toBe('книга');
  });
});

describe('the scrubber (§6F.2)', () => {
  it('places one tick per event on the clock and keeps the right edge for now', () => {
    const items = [event({ hseq: 1 }), event({ hseq: 5 }), event({ hseq: 10 })];
    expect(scrubTicks(items, 10)).toEqual([10, 50, 100]);
    expect(scrubTicks([], 0)).toEqual([]);
    expect(scrubTicks([event({ hseq: 999 })], 10)).toEqual([100]);
  });

  it('labels the right edge «сейчас» and an older moment by its time', () => {
    expect(scrubLabel(10, 10, '2026-10-25T09:00:00Z')).toBe('сейчас');
    expect(scrubLabel(5, 10, '2026-10-25T12:20:00Z')).toMatch(/^\d{2}:\d{2}$/u);
    expect(scrubLabel(0, 10, null)).toBe('начало книги');
  });

  it('steps one tick left and right without leaving the list', () => {
    const items = [event({ hseq: 3 }), event({ hseq: 7 }), event({ hseq: 12 })];
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
