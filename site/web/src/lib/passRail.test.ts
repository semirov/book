import type { PassStage, PassStageEvent, StageSpan } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { eventsOfPass, livePassOf, liveRunOf } from './passRail.ts';

/**
 * The live block: which paragraph a running pass is writing, and from when. The reader's rail
 * (stage words, durations, receipts) is gone; these are the only facts the prose needs.
 */

const at = (iso: string): number => Date.parse(iso);
const T0 = at('2026-10-28T08:18:00Z');
const MIN = 60_000;

const span: StageSpan[] = [
  { blockId: 'ch07#bbbb2222', before: 'Второй абзац до подхода писателя.', after: 'Второй абзац, переписанный на ходу.', truncated: false },
];

function event(stage: PassStage, seq: number, overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 7,
    stageSeq: seq,
    stage,
    at: T0 + seq * MIN,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: `сводка ${String(seq)}`,
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

const READING = [event('queued', 1, { at: T0 }), event('read', 2, { at: T0 + 4_000, summary: 'читает главу 7' })];

describe('the log’s own helper', () => {
  it('narrows a chapter’s log to one pass, in stage order', () => {
    const foreign = event('landed', 9, { passId: 'stp_other' });
    const own = eventsOfPass([...READING, foreign], 'stp_01J9Z8K4Q7');
    expect(own.map((row) => row.stageSeq)).toEqual([1, 2]);
  });
});

describe('the block a pass is writing', () => {
  const landed = event('landed', 5, { span });
  const typing = event('typing', 6);

  it('takes the landed span and starts at the typing moment', () => {
    const spec = livePassOf([...READING, event('drafting', 4), landed, typing]);
    expect(spec).not.toBeNull();
    expect(spec?.startAt).toBe(typing.at);
    expect(spec?.blockId).toBe('ch07#bbbb2222');
    expect(spec?.after).toBe(span[0]!.after);
  });

  it('has nothing to paint for a pass that only read', () => {
    expect(livePassOf(READING)).toBeNull();
    expect(livePassOf([...READING, event('refused', 3)])).toBeNull();
  });

  it('paints the block the page still holds by id, and its successor by text', () => {
    const spec = livePassOf([landed, typing])!;
    const before = liveRunOf(spec, { id: 'ch07#bbbb2222', text: span[0]!.before });
    expect(before?.text).toBe(span[0]!.after);
    expect(before?.span.kind).toBe('replacement');
    const after = liveRunOf(spec, { id: 'ch07#cccc3333', text: span[0]!.after });
    expect(after?.text).toBe(span[0]!.after);
    expect(liveRunOf(spec, { id: 'ch07#aaaa1111', text: 'Первый абзац.' })).toBeNull();
  });

  it('waits for the chapter when the stage’s side was cut at the bound', () => {
    const cut = event('landed', 5, { span: [{ ...span[0]!, truncated: true }] });
    const spec = livePassOf([cut, typing])!;
    expect(liveRunOf(spec, { id: 'ch07#bbbb2222', text: span[0]!.before })).toBeNull();
  });

  it('is keyed by the pass: a later `typing` names the clock, never a second renderer', () => {
    const landedOnly = livePassOf([landed])!;
    expect(landedOnly.key).toBe(landed.passId);
    expect(livePassOf([landed, typing])?.key).toBe(landedOnly.key);
    expect(livePassOf([typing, landed])?.key).toBe(landedOnly.key);
    expect(landedOnly.startAt).toBe(landed.at);
    expect(livePassOf([landed, typing])?.startAt).toBe(typing.at);
    const earlyTyping = event('typing', 4, { at: T0 + 4 * MIN });
    expect(livePassOf([earlyTyping, landed])?.key).toBe(landedOnly.key);
    expect(livePassOf([earlyTyping, landed])?.startAt).toBe(landed.at);
  });

  it('paints a block the pass only shortened: the deletion, not a skip', () => {
    const shortened = event('landed', 5, {
      span: [{ blockId: 'ch07#bbbb2222', before: 'шум реки затих', after: '', truncated: false }],
    });
    const spec = livePassOf([shortened, typing]);
    expect(spec).not.toBeNull();
    expect(spec?.before).toBe('шум реки затих');
    expect(spec?.after).toBe('');
    const run = liveRunOf(spec!, { id: 'ch07#bbbb2222', text: 'шум реки затих' });
    expect(run?.span.kind).toBe('deletion');
    expect(run?.span.before).toBe('шум реки затих');
    expect(run?.text).toBe('');
  });
});
