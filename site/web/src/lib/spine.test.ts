import type { StateSnapshot } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { bandStyle, chapterPercent, spineMarkers } from './spine.ts';

function state(overrides: Record<string, unknown> = {}): StateSnapshot {
  return {
    version: 1,
    at: '',
    engine: { status: 'unknown', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: null, about: null, rev: 0, updatedAt: null },
    chapters: { total: 42, written: [], empty: [], count: 0, totalChars: 0 },
    cursors: {
      forward: { lane: 'forward', from: 1, to: 21, cursor: null, next: 1, status: 'idle', lastPassAt: null, lastPass: null },
      backward: { lane: 'backward', from: 42, to: 22, cursor: null, next: 42, status: 'idle', lastPassAt: null, lastPass: null },
    },
    toc: [],
    meeting: { forwardFront: null, backwardFront: null, gap: 42, converged: false, seam: 'not_reached' },
    cascade: null,
    queue: {
      depth: 0,
      byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
      head: null,
      processing: null,
      lastDecidedAt: null,
    },
    revising: [],
    current: null,
    unresolved: [],
    activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
    ...overrides,
  } as unknown as StateSnapshot;
}

describe('spineMarkers', () => {
  it('is a hollow line with two carets at 0/42', () => {
    const markers = spineMarkers(state());
    expect(markers.empty).toBe(true);
    expect(markers.forwardFill).toBe(0);
    expect(markers.backwardFill).toBe(0);
    expect(markers.carets).toEqual({ forward: null, backward: null });
    expect(markers.live).toEqual({ forward: false, backward: false });
    expect(markers.seamPercent).toBeCloseTo(51.19, 1);
  });

  it('fills from each end and places the resting carets at the fronts', () => {
    const markers = spineMarkers(
      state({
        chapters: { total: 42, written: [1, 2, 3, 41, 42], empty: [], count: 5, totalChars: 100 },
        meeting: { forwardFront: 3, backwardFront: 41, gap: 37, converged: false, seam: 'not_reached' },
        cursors: {
          forward: { lane: 'forward', from: 1, to: 21, cursor: 3, next: 4, status: 'resting', lastPassAt: null, lastPass: null },
          backward: { lane: 'backward', from: 42, to: 22, cursor: 41, next: 40, status: 'resting', lastPassAt: null, lastPass: null },
        },
      }),
    );
    expect(markers.forwardFill).toBeCloseTo((3 / 42) * 100, 5);
    expect(markers.backwardFill).toBeCloseTo((2 / 42) * 100, 5);
    expect(markers.carets).toEqual({ forward: 3, backward: 41 });
    expect(markers.live).toEqual({ forward: false, backward: false });
  });

  it('blinks only the caret of the lane that is drafting', () => {
    const markers = spineMarkers(
      state({
        chapters: { total: 42, written: [1, 2], empty: [], count: 2, totalChars: 100 },
        current: { lane: 'forward', chapter: 2, kind: 'draft', blockId: null, blockIndex: null, since: '' },
      }),
    );
    expect(markers.carets.forward).toBe(2);
    expect(markers.live).toEqual({ forward: true, backward: false });
  });

  it('never draws a cascade caret where a cascade is not a drafting position', () => {
    const markers = spineMarkers(
      state({
        current: { lane: 'forward', chapter: 9, kind: 'cascade', blockId: null, blockIndex: null, since: '' },
        cascade: {
          id: 'csc_1',
          changeId: 'chg_1',
          wave: 1,
          frontier: { forward: 9, backward: 7 },
          touched: [7, 8, 9],
          lane: 'forward',
          stepChapter: 9,
          startedAt: '',
          budget: { steps: 1, maxSteps: 8, deadline: '' },
        },
      }),
    );
    expect(markers.live.forward).toBe(false);
    // A cascade never moves the drafting caret (§11.3).
    expect(markers.carets).toEqual({ forward: null, backward: null });
    expect(markers.cascade).toEqual({ from: 7, to: 9, step: 9 });
  });
});

describe('book geometry', () => {
  it('puts a chapter centre on the column', () => {
    expect(chapterPercent(1)).toBeCloseTo((0.5 / 42) * 100, 5);
    expect(chapterPercent(42)).toBeCloseTo((41.5 / 42) * 100, 5);
  });

  it('builds a band over the touched chapters', () => {
    const style = bandStyle({ from: 7, to: 9, step: 8 });
    expect(style.left).toBe(`${chapterPercent(7)}%`);
    expect(style.width).toBe(`${chapterPercent(9) - chapterPercent(7)}%`);
  });

  it('never collapses a one-chapter band below a visible width', () => {
    expect(bandStyle({ from: 8, to: 8, step: 8 }).width).toBe('0.4%');
  });
});
