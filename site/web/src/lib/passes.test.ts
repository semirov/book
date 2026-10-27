import type { PassStage, PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { applyStage } from './passes.ts';

/**
 * The page's one fact about a pass: is one working on this chapter right now? The frames that
 * say so are the engine's, and a new server may name a stage this page has never seen — that
 * frame must change nothing and must not throw.
 */

type FrameInput = Omit<Partial<PassStageEvent>, 'stage'> & { stage: string };

function stage(overrides: FrameInput): PassStageEvent {
  return {
    passId: 'pas_01J9Z8K4Q7',
    chapter: 66,
    stageSeq: 1,
    at: 1_764_000_000_000,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: 'глава читается',
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  } as unknown as PassStageEvent;
}

const IN_FLIGHT: readonly PassStage[] = ['queued', 'read', 'verdict', 'drafting'];

describe('applyStage', () => {
  it('marks the chapter in flight on every working stage, keeping the pass and its change', () => {
    let state = {};
    for (const name of IN_FLIGHT) {
      state = applyStage(state, stage({ stage: name, changeId: 'chg_01J9Z8K4Q7' }));
      expect(state).toEqual({
        66: { passId: 'pas_01J9Z8K4Q7', changeId: 'chg_01J9Z8K4Q7', stage: name },
      });
    }
  });

  it('clears the chapter on `landed`, and on `refused` too — the pass is over either way', () => {
    for (const name of ['landed', 'refused'] as const) {
      const held = applyStage({}, stage({ stage: 'drafting' }));
      expect(applyStage(held, stage({ stage: name, stageSeq: 4 }))).toEqual({});
    }
  });

  it('ignores a stage this page does not know, without throwing', () => {
    const held = applyStage({}, stage({ stage: 'drafting' }));
    // A newer server's vocabulary: neither a start nor an end for this page.
    expect(applyStage(held, stage({ stage: 'reviewing' }))).toBe(held);
    expect(applyStage({}, stage({ stage: 'reviewing' }))).toEqual({});
    expect(applyStage({}, stage({ stage: '' }))).toEqual({});
    expect(applyStage({}, stage({ stage: undefined as unknown as string }))).toEqual({});
  });

  it('leaves a pass in flight on `typing`: the work is not over, it is being written', () => {
    const held = applyStage({}, stage({ stage: 'drafting' }));
    expect(applyStage(held, stage({ stage: 'typing', stageSeq: 3 }))).toBe(held);
  });

  it('returns the same object when a repeated frame changes nothing (no re-render)', () => {
    const held = applyStage({}, stage({ stage: 'read' }));
    expect(applyStage(held, stage({ stage: 'read' }))).toBe(held);
    expect(applyStage({}, stage({ stage: 'landed' }))).toEqual({});
  });

  it('does not let one pass’s `landed` clear another pass’s flight', () => {
    const held = applyStage({}, stage({ passId: 'pas_second', stage: 'drafting' }));
    expect(applyStage(held, stage({ passId: 'pas_first', stage: 'landed' }))).toBe(held);
    // The chapter's own pass ends it, and a second pass replaces the first rather than joining it.
    expect(applyStage(held, stage({ passId: 'pas_second', stage: 'landed' }))).toEqual({});
    expect(applyStage(held, stage({ passId: 'pas_third', stage: 'queued' }))).toEqual({
      66: { passId: 'pas_third', changeId: null, stage: 'queued' },
    });
  });

  it('ignores a frame that names no real chapter', () => {
    expect(applyStage({}, stage({ stage: 'queued', chapter: 0 }))).toEqual({});
    expect(applyStage({}, stage({ stage: 'queued', chapter: Number.NaN }))).toEqual({});
  });
});
