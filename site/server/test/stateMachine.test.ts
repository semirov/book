import { TOTAL_CHAPTERS } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { deriveState, stateFingerprint, type ChapterFact } from '../src/ingest/stateMachine.ts';

const now = new Date('2026-10-25T12:00:00Z');

function fact(n: number, overrides: Partial<ChapterFact> = {}): ChapterFact {
  return {
    n,
    rev: 1,
    title: `Глава ${n}`,
    chars: 9000,
    blocks: 120,
    writtenAt: '2026-10-25T09:00:00Z',
    updatedAt: '2026-10-25T09:30:00Z',
    ...overrides,
  };
}

function derive(facts: ChapterFact[], version = 1) {
  return deriveState({ facts, now, version });
}

describe('empty book', () => {
  const state = derive([]);

  it('has every explicit empty slot and no written chapter', () => {
    expect(state.chapters.total).toBe(TOTAL_CHAPTERS);
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.empty).toHaveLength(TOTAL_CHAPTERS);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
  });

  it('reports the gap as the whole book', () => {
    expect(state.meeting.forwardFront).toBeNull();
    expect(state.meeting.backwardFront).toBeNull();
    expect(state.meeting.gap).toBe(TOTAL_CHAPTERS);
    expect(state.meeting.converged).toBe(false);
    expect(state.meeting.seam).toBe('not_reached');
  });

  it('points both lanes at their first chapter', () => {
    expect(state.cursors.forward).toMatchObject({ lane: 'forward', from: 1, to: 21, cursor: null, next: 1 });
    expect(state.cursors.backward).toMatchObject({
      lane: 'backward',
      from: TOTAL_CHAPTERS,
      to: 22,
      cursor: null,
      next: TOTAL_CHAPTERS,
    });
    expect(state.cursors.forward.status).toBe('idle');
  });

  it('is honest about a missing engine', () => {
    expect(state.engine).toEqual({ status: 'unknown', heartbeatAt: null, laneId: null });
    expect(state.queue.depth).toBe(0);
    expect(state.cascade).toBeNull();
    expect(state.current).toBeNull();
    expect(state.activity).toEqual({
      lastFileChangeAt: null,
      lastEngineEventAt: null,
      lastLogLineAt: null,
      source: 'files',
    });
    expect(state.phase).toBe('draft');
    expect(state.front).toEqual({ title: null, about: null, rev: 0, updatedAt: null });
  });

  it('serves a full TOC even when nothing is written', () => {
    expect(state.toc).toHaveLength(TOTAL_CHAPTERS);
    // The opening and the finale stand outside the parts (BOOK-155).
    expect(state.toc[0]).toEqual({ part: null, n: 1, title: null, written: false, rev: 0 });
    expect(state.toc[TOTAL_CHAPTERS - 1]).toEqual({
      part: null,
      n: TOTAL_CHAPTERS,
      title: null,
      written: false,
      rev: 0,
    });
  });
});

describe('the first sheet', () => {
  it('paints the cover and page 2 from the parsed file only', () => {
    const withFront = deriveState({
      facts: [],
      now,
      version: 1,
      front: { title: 'Без названия', about: 'О чём эта книга.', rev: 3, updatedAt: '2026-10-25T10:00:00Z' },
    });
    expect(withFront.front).toMatchObject({ title: 'Без названия', rev: 3 });
  });

  it('puts chapter titles into the TOC and keeps an untitled chapter as a slot', () => {
    const withTitles = derive([fact(1), fact(2, { title: null })]);
    expect(withTitles.toc[0]).toEqual({ part: null, n: 1, title: 'Глава 1', written: true, rev: 1 });
    expect(withTitles.toc[1]).toEqual({ part: 1, n: 2, title: null, written: true, rev: 1 });
  });
});

describe('one chapter', () => {
  it('writes the forward front and leaves the gap to the rest', () => {
    const state = derive([fact(1, { chars: 9343 })]);
    expect(state.chapters.written).toEqual([1]);
    expect(state.chapters.empty).toHaveLength(TOTAL_CHAPTERS - 1);
    expect(state.chapters.totalChars).toBe(9343);
    expect(state.meeting.forwardFront).toBe(1);
    expect(state.meeting.backwardFront).toBeNull();
    expect(state.meeting.gap).toBe(TOTAL_CHAPTERS - 1);
    expect(state.cursors.forward.next).toBe(2);
    expect(state.cursors.backward.next).toBe(TOTAL_CHAPTERS);
  });

  it('ignores a chapter with no blocks: a zero-byte file is not written', () => {
    const state = derive([fact(1, { blocks: 0, chars: 0 })]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.empty).toHaveLength(TOTAL_CHAPTERS);
  });
});

describe('two fronts', () => {
  const facts = [1, 2, 3, 4, 5, 6, 7, 8, 41, 42].map((n) => fact(n));
  const state = derive(facts);

  it('counts both halves', () => {
    expect(state.chapters.written).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 41, 42]);
    expect(state.chapters.count).toBe(10);
    expect(state.meeting.forwardFront).toBe(8);
    expect(state.meeting.backwardFront).toBe(41);
    expect(state.meeting.gap).toBe(32);
    expect(state.meeting.converged).toBe(false);
  });

  it('advances each lane inward', () => {
    expect(state.cursors.forward.next).toBe(9);
    expect(state.cursors.backward.next).toBe(40);
  });

  it('takes the latest write as the last activity', () => {
    const latest = derive([fact(1, { updatedAt: '2026-10-25T08:00:00Z' }), fact(2, { updatedAt: '2026-10-25T11:00:00Z' })]);
    expect(latest.activity.lastFileChangeAt).toBe('2026-10-25T11:00:00Z');
  });
});

describe('a fact outside the book (BOOK-155)', () => {
  it('never reaches the catalog, the count or the meeting arithmetic', () => {
    // A row written before the cut (chapter 65) survives in storage; the book no longer has it.
    const state = derive([fact(1), fact(65, { blocks: 3, chars: 12_345 })]);
    expect(state.chapters.written).toEqual([1]);
    expect(state.chapters.count).toBe(1);
    expect(state.chapters.total).toBe(TOTAL_CHAPTERS);
    expect(state.chapters.totalChars).toBe(9000);
    expect(state.chapters.empty).toHaveLength(TOTAL_CHAPTERS - 1);
    expect(state.toc).toHaveLength(TOTAL_CHAPTERS);
    expect(state.toc.some((entry) => entry.n === 65)).toBe(false);
    // The gap counts the book, not the storage: one written chapter leaves TOTAL_CHAPTERS − 1.
    expect(state.meeting.gap).toBe(TOTAL_CHAPTERS - 1);
    expect(state.meeting.forwardFront).toBe(1);
    expect(state.meeting.backwardFront).toBeNull();
  });
});

describe('the meeting', () => {
  it('is converged when the fronts are adjacent', () => {
    const state = derive([fact(21), fact(22)]);
    expect(state.meeting.forwardFront).toBe(21);
    expect(state.meeting.backwardFront).toBe(22);
    expect(state.meeting.gap).toBe(0);
    expect(state.meeting.converged).toBe(true);
    expect(state.meeting.seam).toBe('open');
    expect(state.cursors.forward.next).toBeNull();
    expect(state.cursors.backward.next).toBeNull();
  });

  it('is converged when the fronts overlap', () => {
    const state = derive([fact(21), fact(22), fact(23)]);
    expect(state.meeting.gap).toBe(0);
    expect(state.meeting.converged).toBe(true);
  });

  it('is not converged while one chapter is still missing', () => {
    const state = derive([fact(20), fact(22)]);
    expect(state.meeting.gap).toBe(1);
    expect(state.meeting.converged).toBe(false);
  });
});

describe('snapshots', () => {
  it('carries the version it was given', () => {
    expect(derive([], 42).version).toBe(42);
  });

  it('formats `at` as ISO-8601 UTC without milliseconds', () => {
    expect(derive([]).at).toBe('2026-10-25T12:00:00Z');
  });
});

describe('stateFingerprint', () => {
  it('ignores the order of facts', () => {
    expect(stateFingerprint([fact(2), fact(1)])).toBe(stateFingerprint([fact(1), fact(2)]));
  });

  it('changes when a revision changes', () => {
    expect(stateFingerprint([fact(1)])).not.toBe(stateFingerprint([fact(1, { rev: 2 })]));
  });

  it('changes when a title or the first sheet changes', () => {
    expect(stateFingerprint([fact(1)])).not.toBe(stateFingerprint([fact(1, { title: 'Другое' })]));
    expect(stateFingerprint([], { title: null, about: null, rev: 0, updatedAt: null })).not.toBe(
      stateFingerprint([], { title: 'Книга', about: 'О чём.', rev: 1, updatedAt: '2026-10-25T10:00:00Z' }),
    );
  });

  it('changes when a slot gains or loses its basis sentence (BOOK-6)', () => {
    expect(stateFingerprint([], undefined, '', [1, TOTAL_CHAPTERS])).not.toBe(stateFingerprint([], undefined, '', []));
    // Order is not identity here either.
    expect(stateFingerprint([], undefined, '', [TOTAL_CHAPTERS, 1])).toBe(
      stateFingerprint([], undefined, '', [1, TOTAL_CHAPTERS]),
    );
  });

  it('changes when the first reader change turns history on (BOOK-56)', () => {
    expect(stateFingerprint([], undefined, '', [], 1)).not.toBe(stateFingerprint([], undefined, '', [], 0));
  });

  it('changes when the log’s first record starts the chronicle (BOOK-56)', () => {
    // Same facts, same reader count: only the book's own beginning differs.
    expect(stateFingerprint([], undefined, '', [], 0, true)).not.toBe(stateFingerprint([], undefined, '', [], 0));
    expect(stateFingerprint([], undefined, '', [], 0, false)).toBe(stateFingerprint([], undefined, '', [], 0));
  });
});

describe('history (BOOK-56)', () => {
  it('is off on an empty log, which has not even begun', () => {
    expect(derive([]).history).toEqual({ live: false, readerChanges: 0, started: false });
  });

  it('turns on with one reader change, and only with a positive count', () => {
    expect(deriveState({ facts: [], now, version: 1, readerChanges: 1 }).history).toEqual({
      live: true,
      readerChanges: 1,
      started: true,
    });
    expect(deriveState({ facts: [], now, version: 1, readerChanges: -3 }).history).toEqual({
      live: false,
      readerChanges: 0,
      started: false,
    });
  });

  it('starts the chronicle from the log’s first record, before any reader change', () => {
    expect(deriveState({ facts: [], now, version: 1, started: true }).history).toEqual({
      live: false,
      readerChanges: 0,
      started: true,
    });
    // A record stays a record: a reader change starts the chronicle even if the caller said
    // nothing about the log.
    expect(deriveState({ facts: [], now, version: 1, readerChanges: 2 }).history.started).toBe(true);
    expect(deriveState({ facts: [], now, version: 1, started: false }).history.started).toBe(false);
  });
});

describe('a slot that holds only its basis sentence (BOOK-6)', () => {
  it('is named explicitly and counted as no chapter and no character', () => {
    const state = deriveState({ facts: [], basis: [1, TOTAL_CHAPTERS], now, version: 1 });
    expect(state.chapters.basis).toEqual([1, TOTAL_CHAPTERS]);
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
    // The basis slots are part of the explicit complement the page draws its slots from.
    expect(state.chapters.empty).toHaveLength(TOTAL_CHAPTERS);
    expect(state.toc.every((entry) => !entry.written)).toBe(true);
  });

  it('cannot be both written and a basis slot, and never invents a number', () => {
    const state = deriveState({ facts: [], basis: [1, 1, 99, -3], now, version: 1 });
    expect(state.chapters.basis).toEqual([1]);
    const written = deriveState({ facts: [fact(1)], basis: [1, TOTAL_CHAPTERS], now, version: 1 });
    expect(written.chapters.basis).toEqual([TOTAL_CHAPTERS]);
    expect(written.chapters.written).toEqual([1]);
  });
});
