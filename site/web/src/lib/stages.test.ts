import type { PassStage, PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { applyStage } from './passes.ts';
import { MAX_STAGE_EVENTS, appendStage, inFlightOf, type StagesLog } from './stages.ts';

/**
 * The page's stage log: bounded, deduped, and the one source of the in-flight flags the
 * chapters already read. The hook is a `useState` around these two functions; the rules they
 * hold are the rules `App` relies on.
 */

const T0 = Date.parse('2026-10-28T08:18:00Z');

function event(stage: PassStage, seq: number, overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 7,
    stageSeq: seq,
    stage,
    at: T0 + seq * 1_000,
    actor: { process: 'writer', model: null },
    changeId: null,
    summary: `сводка ${String(seq)}`,
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

describe('the log takes frames and nothing else', () => {
  it('appends one event per chapter, in the pass’s order', () => {
    const log = appendStage(appendStage({}, event('drafting', 2)), event('read', 1));
    expect(log[7]?.map((one) => one.stage)).toEqual(['read', 'drafting']);
  });

  it('returns the same log for a repeated frame', () => {
    const once = appendStage({}, event('read', 1));
    expect(appendStage(once, event('read', 1, { summary: 'другая строка' }))).toBe(once);
  });

  it('drops a chapter that is not a chapter and a stage that is not a stage', () => {
    expect(appendStage({}, event('read', 1, { chapter: 0 }))).toEqual({});
    expect(appendStage({}, event('read', 1, { stage: 'invented' as PassStage }))).toEqual({});
  });

  it('keeps the last forty events of a chapter', () => {
    let log: StagesLog = {};
    for (let seq = 1; seq <= 50; seq += 1) log = appendStage(log, event('drafting', seq));
    expect(log[7]).toHaveLength(MAX_STAGE_EVENTS);
    expect(log[7]?.[0]?.stageSeq).toBe(11);
    expect(log[7]?.at(-1)?.stageSeq).toBe(50);
  });
});

describe('the in-flight flags are the same fold the chapters already read', () => {
  it('folds the log with `applyStage`, so both cannot disagree', () => {
    let log: StagesLog = {};
    for (const one of [event('queued', 1), event('read', 2), event('verdict', 3), event('drafting', 4)]) {
      log = appendStage(log, one);
    }
    const folded = inFlightOf(log);
    expect(folded[7]).toEqual({ passId: 'stp_01J9Z8K4Q7', changeId: null, stage: 'drafting' });
    expect(folded).toEqual(applyStage(applyStage({}, event('queued', 1)), event('drafting', 4)));
  });

  it('clears the chapter on its own pass’s landing, and not on another pass’s', () => {
    let log: StagesLog = {};
    for (const one of [event('drafting', 1), event('typing', 2)]) log = appendStage(log, one);
    // `typing` belongs to a pass already in flight: the chapter stays marked.
    expect(inFlightOf(log)[7]?.stage).toBe('drafting');
    log = appendStage(log, event('landed', 3, { passId: 'stp_other' }));
    expect(inFlightOf(log)[7]?.stage).toBe('drafting');
    log = appendStage(log, event('landed', 4));
    expect(inFlightOf(log)[7]).toBeUndefined();
  });

  it('keeps a chapter per key', () => {
    const log = appendStage(appendStage({}, event('read', 1)), event('read', 1, { chapter: 8, passId: 'stp_8' }));
    expect(Object.keys(log).map(Number).sort()).toEqual([7, 8]);
    expect(inFlightOf(log)[8]?.passId).toBe('stp_8');
  });
});
