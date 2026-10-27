import type { ChangeDecidedPayload, ChangeProcessingPayload, CascadeProgressPayload, StateSnapshot } from '@book/shared';
import { CASCADE_MAX_WAVE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  escalationMarkers,
  reduceRibbon,
  ribbonAfterSnapshot,
  ribbonFromState,
  ribbonMaxWave,
  ribbonSummary,
  rippleIsLive,
  wingLine,
  wingOfChapter,
  wingReachedCopy,
  wingStateCopy,
  RIBBON_MAX_WAVE,
  type Ribbon,
} from './cascade.ts';

function state(cascade: StateSnapshot['cascade']): StateSnapshot {
  return {
    version: 1,
    at: '',
    engine: { status: 'running', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: null, about: null, rev: 0, updatedAt: null },
    chapters: { total: 67, written: [7, 8, 9], empty: [], count: 3, totalChars: 0, basis: [] },
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
    history: { live: true, readerChanges: 1, started: true },
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
  wings: {
    down: { frontier: 7, wave: 1, state: 'moving', reached: [7] },
    up: { frontier: 9, wave: 1, state: 'moving', reached: [9] },
  },
  seams: [{ boundary: 9, reason: 'в главе 9 ключ теперь у другого' }],
  wing: 'upward',
  lane: 'forward',
  stepChapter: 9,
  startedAt: '2026-10-25T12:00:00Z',
  budget: { steps: 3, maxSteps: 8, deadline: '2026-10-25T12:30:00Z' },
};

describe('the wave bound the ribbon reads', () => {
  it('falls back to the shipped default when the frame carries no number', () => {
    expect(RIBBON_MAX_WAVE).toBe(CASCADE_MAX_WAVE);
    expect(ribbonMaxWave(undefined)).toBe(CASCADE_MAX_WAVE);
    expect(ribbonMaxWave(null)).toBe(CASCADE_MAX_WAVE);
    // A frame is not trusted blindly: only a positive integer is a bound.
    expect(ribbonMaxWave(0)).toBe(CASCADE_MAX_WAVE);
    expect(ribbonMaxWave(-2)).toBe(CASCADE_MAX_WAVE);
    expect(ribbonMaxWave(2.5)).toBe(CASCADE_MAX_WAVE);
    expect(ribbonMaxWave(Number.NaN)).toBe(CASCADE_MAX_WAVE);
    expect(ribbonMaxWave('4')).toBe(CASCADE_MAX_WAVE);
  });

  it('uses the number the server announced', () => {
    expect(ribbonMaxWave(5)).toBe(5);
    expect(ribbonMaxWave(4)).toBe(4);
  });
});

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
    wings: {
      down: { frontier: 7, wave: 1, state: 'moving', reached: [7] },
      up: { frontier: 8, wave: 0, state: 'waiting', reached: [] },
    },
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
    wings: {
      down: { frontier: 7, wave: 1, state: 'moving', reached: [7] },
      up: { frontier: 9, wave: 1, state: 'moving', reached: [8, 9] },
    },
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
      wings: {
        down: { frontier: 7, wave: 2, state: 'settled', reached: [7] },
        up: { frontier: 9, wave: 2, state: 'settled', reached: [9] },
      },
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
    expect(markers[1]?.boundary).toBe('front');
    expect(markers[2]?.boundary).toBe('ending');
    expect(markers[2]?.changeId).toBeNull();
  });
});

describe('both wings, as data', () => {
  const ribbon = ribbonFromState(state(OPEN_CASCADE))!;

  it('names each wing and never a percentage', () => {
    expect(ribbonSummary(ribbon)).toBe('правка: глава 8 · вниз до главы 7 · вверх до главы 9');
    expect(ribbonSummary({ ...ribbon, status: 'escalated' })).toContain('стык пересматривается');
    expect(ribbonSummary(ribbon)).not.toContain('%');
  });

  it('prints a wing’s own wave, state and reached chapters', () => {
    // BOOK-59: the one wave a ripple has is not news, and there is never a «волна 0».
    expect(wingLine('down', ribbon.wings.down)).toBe('вниз · идёт');
    // Only a second wave says anything, and it got there by the owner's decision.
    expect(wingLine('up', { ...ribbon.wings.up, wave: 2, state: 'moving' })).toBe('вверх · волна 2 · решением · идёт');
    expect(wingReachedCopy(ribbon.wings.down)).toBe('07');
  });

  it('prints nothing for a wing that reached nothing, in every state (BOOK-70)', () => {
    // The state word already stands in `wingLine`; a «дальше держится» or a bare «—» would be
    // the same fact twice, or a claim the data does not make.
    for (const state of ['waiting', 'moving', 'stopped', 'settled'] as const) {
      expect(wingReachedCopy({ ...ribbon.wings.up, state, reached: [] }), state).toBe('');
    }
    expect(wingStateCopy('settled')).toBe('остановилось');
    expect(wingStateCopy('stopped')).toBe('остановлено');
    expect(wingStateCopy('moving')).toBe('идёт');
  });

  it('says nothing at all for a wing that never opened (BOOK-137)', () => {
    // A diagnostic is not reading: «не открылось» left every reading surface, and with it the
    // empty wing itself — the ribbon's origin still names the change.
    const waiting = { ...ribbon.wings.up, state: 'waiting' as const, wave: 0, reached: [] };
    expect(wingStateCopy('waiting')).toBe('');
    expect(wingLine('up', waiting)).toBe('');
    expect(wingReachedCopy(waiting)).toBe('');
  });

  it('places a chapter on the wing that reached it', () => {
    expect(wingOfChapter(7, 8)).toBe('down');
    expect(wingOfChapter(9, 8)).toBe('up');
    expect(wingOfChapter(8, 8)).toBe('origin');
  });

  it('draws rings only while a step is in flight', () => {
    expect(rippleIsLive(ribbon)).toBe(true);
    expect(rippleIsLive({ ...ribbon, step: null })).toBe(false);
    expect(rippleIsLive({ ...ribbon, status: 'closed' })).toBe(false);
    expect(rippleIsLive(null)).toBe(false);
  });

  it('keeps a wing that never opened — and its waiting state — through a decision', () => {
    const processing = reduceRibbon(null, {
      type: 'change:processing',
      data: { id: 'chg_1', chapter: 8, startedAt: '', attempt: 1, relevance: null },
    });
    expect(processing?.wings.down).toEqual({ frontier: 8, wave: 0, state: 'waiting', reached: [] });
    expect(processing?.wings.up).toEqual({ frontier: 8, wave: 0, state: 'waiting', reached: [] });
    expect(rippleIsLive(processing)).toBe(false);
  });
});
