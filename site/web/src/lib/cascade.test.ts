import type { ChangeDecidedPayload, ChangeProcessingPayload, CascadeProgressPayload, StateSnapshot } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  boundaryPercent,
  escalationMarkers,
  reduceRibbon,
  ribbonAfterSnapshot,
  ribbonBand,
  ribbonFromState,
  ribbonSummary,
  type Ribbon,
} from './cascade.ts';

function state(cascade: StateSnapshot['cascade']): StateSnapshot {
  return {
    version: 1,
    at: '',
    engine: { status: 'running', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: null, about: null, rev: 0, updatedAt: null },
    chapters: { total: 67, written: [7, 8, 9], empty: [], count: 3, totalChars: 0 },
    cursors: {} as StateSnapshot['cursors'],
    toc: [],
    meeting: { forwardFront: null, backwardFront: null, gap: 67, converged: false, seam: 'not_reached' },
    cascade,
    queue: {
      depth: 0,
      byState: { pending: 0, processing: 1, stale: 0, escalated: 0, done24h: 0 },
      head: null,
      processing: null,
      lastDecidedAt: null,
    },
    revising: [],
    current: null,
    unresolved: [],
    activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
  };
}

const OPEN_CASCADE: NonNullable<StateSnapshot['cascade']> = {
  id: 'csc_1',
  changeId: 'chg_1',
  origin: 8,
  wave: 1,
  frontier: { forward: 9, backward: 7 },
  touched: [7, 8, 9],
  rewritten: [8],
  seams: [{ boundary: 9, reason: 'в главе 9 ключ теперь у другого' }],
  wing: 'upward',
  lane: 'forward',
  stepChapter: 9,
  startedAt: '2026-10-25T12:00:00Z',
  budget: { steps: 3, maxSteps: 8, deadline: '2026-10-25T12:30:00Z' },
};

describe('ribbonFromState', () => {
  it('rebuilds the ripple after a reload', () => {
    const ribbon = ribbonFromState(state(OPEN_CASCADE));
    expect(ribbon).toMatchObject({
      changeId: 'chg_1',
      cascadeId: 'csc_1',
      chapter: 8,
      wave: 1,
      status: 'open',
      touched: [7, 8, 9],
      rewritten: [8],
      step: 9,
      frontier: { down: 7, up: 9 },
    });
    expect(ribbon?.seams[0]).toEqual({ boundary: 9, reason: 'в главе 9 ключ теперь у другого', resolved: false });
  });

  it('draws nothing when there is no open ripple', () => {
    expect(ribbonFromState(state(null))).toBeNull();
  });
});

describe('reduceRibbon', () => {
  const processing: ChangeProcessingPayload = {
    id: 'chg_1',
    chapter: 8,
    startedAt: '2026-10-25T12:00:00Z',
    attempt: 1,
    relevance: null,
  };
  const down: CascadeProgressPayload = {
    cascadeId: 'csc_1',
    changeId: 'chg_1',
    origin: 8,
    wave: 1,
    lane: 'backward',
    chapter: 7,
    boundary: 7,
    phase: 'rewrite',
    outcome: 'rewritten',
    rev: { before: 1, after: 2 },
    frontier: { forward: 8, backward: 7 },
    touched: [7, 8],
    rewritten: [7],
    seamsIn: [{ boundary: 8, reason: 'ключ сдвинулся' }],
    seamsOut: [{ boundary: 6, reason: 'в главе 6 сказано иначе' }],
    budget: { steps: 2, maxSteps: 8, msLeft: 1_000 }
  };
  const up: CascadeProgressPayload = {
    ...down,
    lane: 'forward',
    chapter: 9,
    boundary: 9,
    frontier: { forward: 9, backward: 7 },
    touched: [7, 8, 9],
    rewritten: [7, 9],
    seamsOut: [{ boundary: 10, reason: 'в главе 10 сказано, что ключ у него' }],
  };
  const decided: ChangeDecidedPayload = {
    id: 'chg_1',
    commentId: null,
    outcome: 'applied',
    reason: null,
    chapters: [8, 7, 9],
    cascade: {
      id: 'csc_1',
      outcome: 'consistent',
      waves: 2,
      touched: [7, 8, 9],
      rewritten: [8, 7, 9],
      seams: [
        { boundary: 6, resolved: true },
        { boundary: 10, resolved: true },
      ],
      finding: false,
    },
    relevance: { grade: 'fresh' },
    tokens: { total: 100 },
    decidedAt: '2026-10-25T12:05:00Z',
  };

  it('walks the origin, the downward wing and the upward wing in both directions', () => {
    let ribbon: Ribbon | null = null;
    expect(ribbon).toBeNull();

    ribbon = reduceRibbon(ribbon, { type: 'change:queued', data: { id: 'chg_1' } });
    expect(ribbon).toBeNull();

    ribbon = reduceRibbon(ribbon, { type: 'change:processing', data: processing });
    expect(ribbon).toMatchObject({ chapter: 8, touched: [8], status: 'open', cascadeId: null });

    ribbon = reduceRibbon(ribbon, { type: 'cascade:progress', data: down });
    expect(ribbon).toMatchObject({
      cascadeId: 'csc_1',
      step: 7,
      touched: [7, 8],
      rewritten: [7],
      frontier: { down: 7, up: 8 },
    });

    ribbon = reduceRibbon(ribbon, { type: 'cascade:progress', data: up });
    expect(ribbon).toMatchObject({
      step: 9,
      touched: [7, 8, 9],
      rewritten: [7, 9],
      frontier: { down: 7, up: 9 },
    });
    expect(ribbon?.seams.map((seam) => seam.boundary)).toEqual([6, 10]);

    ribbon = reduceRibbon(ribbon, { type: 'change:decided', data: decided });
    expect(ribbon).toMatchObject({ status: 'closed', outcome: 'applied', step: null });
    expect(ribbon?.seams.every((seam) => seam.resolved)).toBe(true);
  });

  it('keeps the ribbon where an escalated ripple stopped', () => {
    const held = reduceRibbon(reduceRibbon(null, { type: 'change:processing', data: processing }), {
      type: 'cascade:progress',
      data: { ...down, phase: 'escalated', outcome: 'escalated' },
    });
    const closed = reduceRibbon(held, {
      type: 'change:decided',
      data: { ...decided, outcome: 'escalated', cascade: { ...decided.cascade!, seams: [{ boundary: 6, resolved: false }] } },
    });
    expect(closed?.status).toBe('escalated');
    expect(closed?.step).toBeNull();
    expect(closed?.seams.find((seam) => seam.boundary === 6)?.resolved).toBe(false);
  });

  it('ignores a decision for a change it is not drawing', () => {
    expect(reduceRibbon(null, { type: 'change:decided', data: decided })).toBeNull();
  });
});

describe('ribbonAfterSnapshot', () => {
  it('keeps a processing change that has not opened a ripple yet', () => {
    const held = reduceRibbon(null, {
      type: 'change:processing',
      data: { id: 'chg_1', chapter: 8, startedAt: '', attempt: 1, relevance: null },
    });
    expect(ribbonAfterSnapshot(held, state(null))).toBe(held);
  });

  it('drops a ripple the snapshot no longer has, healing a lost decision frame', () => {
    const open = ribbonFromState(state(OPEN_CASCADE));
    expect(ribbonAfterSnapshot(open, state(null))).toBeNull();
    expect(ribbonAfterSnapshot({ ...open!, status: 'closed' }, state(null))).toBeNull();
  });

  it('takes the snapshot as the authority when a ripple is open', () => {
    const held = ribbonFromState(state(OPEN_CASCADE));
    const fresh = state({ ...OPEN_CASCADE, wave: 2, stepChapter: 7 });
    expect(ribbonAfterSnapshot(held, fresh)).toMatchObject({ wave: 2, step: 7 });
  });
});

describe('escalation markers', () => {
  it('turns unresolved seams into persistent dashed positions', () => {
    const markers = escalationMarkers([
      { boundary: 8, reason: 'budget', changeId: 'chg_9', since: '2026-10-25T12:00:00Z', note: 'ключ теперь у другого' },
      { boundary: 8, reason: 'budget', changeId: 'chg_9', since: '2026-10-25T12:00:00Z', note: 'дубль' },
      { boundary: 'front', reason: 'finding', changeId: 'chg_8', since: '2026-10-25T12:00:00Z', note: null },
      { boundary: 'ending', reason: 'ending', changeId: null, since: '2026-10-25T12:00:00Z', note: null },
    ]);
    expect(markers).toHaveLength(3);
    expect(markers[0]).toMatchObject({ boundary: 8, reason: 'budget', note: 'ключ теперь у другого' });
    expect(markers[0]?.percent).toBeCloseTo((7 / 67) * 100, 5);
    expect(markers[1]?.percent).toBe(0);
    expect(markers[2]?.percent).toBe(100);
    expect(markers[2]?.changeId).toBeNull();
  });

  it('places a boundary between its two chapters', () => {
    expect(boundaryPercent('front')).toBe(0);
    expect(boundaryPercent('ending')).toBe(100);
    expect(boundaryPercent(2)).toBeCloseTo((1 / 67) * 100, 5);
  });
});

describe('ribbon geometry and copy', () => {
  const ribbon = ribbonFromState(state(OPEN_CASCADE))!;

  it('spans exactly the touched chapters and never the book', () => {
    const band = ribbonBand(ribbon);
    expect(Number.parseFloat(band.left)).toBeCloseTo((6.5 / 67) * 100, 3);
    expect(Number.parseFloat(band.width)).toBeLessThan(10);
  });

  it('says the route and never a percentage', () => {
    expect(ribbonSummary(ribbon)).toBe('правка: глава 8 → 7 и 9');
    expect(ribbonSummary({ ...ribbon, status: 'escalated' })).toContain('стык пересматривается');
    expect(ribbonSummary(ribbon)).not.toContain('%');
  });
});
