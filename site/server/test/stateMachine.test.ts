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

  it('has 67 explicit empty slots and no written chapter', () => {
    expect(state.chapters.total).toBe(67);
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.empty).toHaveLength(67);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.totalChars).toBe(0);
  });

  it('reports the gap as the whole book', () => {
    expect(state.meeting.forwardFront).toBeNull();
    expect(state.meeting.backwardFront).toBeNull();
    expect(state.meeting.gap).toBe(67);
    expect(state.meeting.converged).toBe(false);
    expect(state.meeting.seam).toBe('not_reached');
  });

  it('points both lanes at their first chapter', () => {
    expect(state.cursors.forward).toMatchObject({ lane: 'forward', from: 1, to: 34, cursor: null, next: 1 });
    expect(state.cursors.backward).toMatchObject({ lane: 'backward', from: 67, to: 35, cursor: null, next: 67 });
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

  it('serves a 67-entry TOC even when nothing is written', () => {
    expect(state.toc).toHaveLength(67);
    expect(state.toc[0]).toEqual({ part: 1, n: 1, title: null, written: false, rev: 0 });
    expect(state.toc[66]).toEqual({ part: 4, n: 67, title: null, written: false, rev: 0 });
  });
});

describe('the first sheet', () => {
  it('paints the cover and page 2 from the parsed file only', () => {
    const withFront = deriveState({
      facts: [],
      now,
      version: 1,
      front: { title: 'Земля, которая больше не кормит', about: 'О чём эта книга.', rev: 3, updatedAt: '2026-10-25T10:00:00Z' },
    });
    expect(withFront.front).toMatchObject({ title: 'Земля, которая больше не кормит', rev: 3 });
  });

  it('puts chapter titles into the TOC and keeps an untitled chapter as a slot', () => {
    const withTitles = derive([fact(1), fact(2, { title: null })]);
    expect(withTitles.toc[0]).toEqual({ part: 1, n: 1, title: 'Глава 1', written: true, rev: 1 });
    expect(withTitles.toc[1]).toEqual({ part: 1, n: 2, title: null, written: true, rev: 1 });
  });
});

describe('one chapter', () => {
  it('writes the forward front and leaves the gap to the rest', () => {
    const state = derive([fact(1, { chars: 9343 })]);
    expect(state.chapters.written).toEqual([1]);
    expect(state.chapters.empty).toHaveLength(66);
    expect(state.chapters.totalChars).toBe(9343);
    expect(state.meeting.forwardFront).toBe(1);
    expect(state.meeting.backwardFront).toBeNull();
    expect(state.meeting.gap).toBe(66);
    expect(state.cursors.forward.next).toBe(2);
    expect(state.cursors.backward.next).toBe(67);
  });

  it('ignores a chapter with no blocks: a zero-byte file is not written', () => {
    const state = derive([fact(1, { blocks: 0, chars: 0 })]);
    expect(state.chapters.count).toBe(0);
    expect(state.chapters.written).toEqual([]);
    expect(state.chapters.empty).toHaveLength(67);
  });
});

describe('two fronts', () => {
  const facts = [1, 2, 3, 4, 5, 6, 7, 8, 66, 67].map((n) => fact(n));
  const state = derive(facts);

  it('counts both halves', () => {
    expect(state.chapters.written).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 66, 67]);
    expect(state.chapters.count).toBe(10);
    expect(state.meeting.forwardFront).toBe(8);
    expect(state.meeting.backwardFront).toBe(66);
    expect(state.meeting.gap).toBe(57);
    expect(state.meeting.converged).toBe(false);
  });

  it('advances each lane inward', () => {
    expect(state.cursors.forward.next).toBe(9);
    expect(state.cursors.backward.next).toBe(65);
  });

  it('takes the latest write as the last activity', () => {
    const latest = derive([fact(1, { updatedAt: '2026-10-25T08:00:00Z' }), fact(2, { updatedAt: '2026-10-25T11:00:00Z' })]);
    expect(latest.activity.lastFileChangeAt).toBe('2026-10-25T11:00:00Z');
  });
});

describe('the meeting', () => {
  it('is converged when the fronts are adjacent', () => {
    const state = derive([fact(34), fact(35)]);
    expect(state.meeting.forwardFront).toBe(34);
    expect(state.meeting.backwardFront).toBe(35);
    expect(state.meeting.gap).toBe(0);
    expect(state.meeting.converged).toBe(true);
    expect(state.meeting.seam).toBe('open');
    expect(state.cursors.forward.next).toBeNull();
    expect(state.cursors.backward.next).toBeNull();
  });

  it('is converged when the fronts overlap', () => {
    const state = derive([fact(34), fact(35), fact(36)]);
    expect(state.meeting.gap).toBe(0);
    expect(state.meeting.converged).toBe(true);
  });

  it('is not converged while one chapter is still missing', () => {
    const state = derive([fact(33), fact(35)]);
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
});
