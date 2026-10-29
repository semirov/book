import type { PassStage, PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { HEAD_SILENCE_MS, HEAD_STOPPED, HEAD_LIVE, headStatusOf, type HeadState, type HeadStages } from './headStatus.ts';
import { inFlightOf, type StagesLog } from './useStages.ts';

/**
 * BOOK-207 — the head's one word, as a function of the facts the page already holds.
 *
 * The owner asked for «что-то типа „сейчас идёт работа“», and the designer's two words are
 * asserted literally: `сейчас пишется` and `сейчас тихо`. The old line (`книга пишется ·
 * глава 12 · 14:21`) is deleted whole, so this file also proves that no chapter and no clock
 * can be rejoined to the word later. The 90 s boundary is exact: 90 000 ms is still writing,
 * 90 001 is not.
 */

/** 14:21 in Moscow (UTC+3), the site's one timezone. */
const AT = Date.parse('2026-10-28T11:21:00Z');
const WRITING = '2026-10-28T11:21:05Z';

function event(stage: PassStage, seq: number, overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 12,
    stageSeq: seq,
    stage,
    at: AT + (seq - 1) * 1_000,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: 'глава пишется',
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

/** A log built the way the page builds it: the frames folded by `inFlightOf`, never by hand. */
function stagesOf(...events: PassStageEvent[]): HeadStages {
  const log: Record<number, PassStageEvent[]> = {};
  for (const one of events) (log[one.chapter] ??= []).push(one);
  const typed: StagesLog = log;
  return { log: typed, passes: inFlightOf(typed) };
}

/** The state the page holds, narrowed to the facts the head reads. */
function stateOf(overrides: Partial<HeadState> = {}): HeadState {
  return {
    engine: { status: 'running', heartbeatAt: WRITING },
    queue: { processing: null },
    revising: [],
    ...overrides,
  };
}

const live = (...events: PassStageEvent[]): ReturnType<typeof headStatusOf> =>
  headStatusOf({ stages: stagesOf(...events), state: stateOf(), nowMs: AT + 20_000 });

describe('the head’s one word while a pass is in flight', () => {
  it('says «сейчас пишется» and nothing else — no chapter, no clock, no stage', () => {
    const status = live(event('queued', 1), event('read', 2), event('drafting', 3));
    expect(status.kind).toBe('live');
    expect(status.full).toBe(HEAD_LIVE);
    expect(status.full).toBe('сейчас пишется');
    const printed = status.full ?? '';
    expect(printed).not.toContain('глава');
    expect(printed).not.toMatch(/\d{2}:\d{2}/u);
    expect(printed).not.toContain('книга пишется');
    expect(printed).not.toContain('проход');
    expect(printed).not.toMatch(/deepseek|flash|writer|модел/iu);
    expect(printed).toBe(printed.toLowerCase());
    // The timer counts from the newest fact, not from the pass's first one.
    expect(status.atMs).toBe(AT + 2_000);
  });

  it('says the same word whichever chapter or snapshot fact names the pass', () => {
    const queued = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ queue: { processing: { chapter: 7, startedAt: '2026-10-28T11:20:00Z' } } }),
      nowMs: AT + 30_000,
    });
    expect(queued.full).toBe('сейчас пишется');
    expect(queued.atMs).toBe(Date.parse('2026-10-28T11:20:00Z'));
    const revising = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ revising: [{ chapter: 9, since: '2026-10-28T11:21:00Z' }] }),
      nowMs: AT + 10_000,
    });
    expect(revising.full).toBe('сейчас пишется');
    // A pass whose stages never reached the page is still real; its clock is the snapshot's.
    const passes = { 12: { passId: 'stp_01J9Z8K4Q7', changeId: null, stage: 'queued' as const } };
    const missed = headStatusOf({ stages: { log: {}, passes }, state: stateOf(), nowMs: AT + 3_000 });
    expect(missed.kind).toBe('live');
    expect(missed.atMs).toBe(Date.parse(WRITING));
  });
});

describe('the 90 s silence', () => {
  const silent = (nowMs: number) =>
    headStatusOf({ stages: stagesOf(event('drafting', 3)), state: stateOf(), nowMs });

  it('is still writing at 90 000 ms and quiet one millisecond later', () => {
    expect(silent(AT + 2_000 + HEAD_SILENCE_MS).kind).toBe('live');
    const stopped = silent(AT + 2_000 + HEAD_SILENCE_MS + 1);
    expect(stopped.kind).toBe('stopped');
    expect(stopped.full).toBe(HEAD_STOPPED);
    expect(stopped.full).toBe('сейчас тихо');
    expect(stopped.full).not.toContain('книга');
    expect(stopped.full).not.toContain('глава');
    expect(stopped.full).not.toMatch(/\d{2}:\d{2}/u);
    expect(stopped.atMs).toBe(AT + 2_000);
  });

  it('is quiet the moment the engine reports it down or absent, however fresh the stage is', () => {
    for (const status of ['down', 'absent'] as const) {
      const held = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf({ engine: { status, heartbeatAt: WRITING } }),
        nowMs: AT + 2_500,
      });
      expect(held.kind, status).toBe('stopped');
      expect(held.full).toBe('сейчас тихо');
    }
    // `paused` and `throttled` are not a stopped engine: the pass may still land.
    for (const status of ['paused', 'throttled', 'unknown'] as const) {
      const held = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf({ engine: { status, heartbeatAt: WRITING } }),
        nowMs: AT + 2_500,
      });
      expect(held.kind, status).toBe('live');
      expect(held.full).toBe('сейчас пишется');
    }
  });
});

describe('no pass in flight', () => {
  it('prints nothing at all — not «простоя», not «0»', () => {
    const status = headStatusOf({ stages: stagesOf(), state: stateOf(), nowMs: AT });
    expect(status).toEqual({ kind: 'idle', full: null, atMs: null });
  });

  it('prints nothing for a new book, a landed pass or a missing log', () => {
    expect(
      headStatusOf({ stages: stagesOf(), state: stateOf({ engine: { status: 'absent', heartbeatAt: null } }), nowMs: AT })
        .kind,
    ).toBe('idle');
    expect(
      headStatusOf({
        stages: stagesOf(event('drafting', 3), event('landed', 4)),
        state: stateOf(),
        nowMs: AT + 5_000,
      }).kind,
    ).toBe('idle');
    expect(headStatusOf({ stages: undefined, state: stateOf(), nowMs: AT }).kind).toBe('idle');
    expect(headStatusOf({ stages: null, state: stateOf(), nowMs: AT }).kind).toBe('idle');
  });

  it('ignores an ended revision mark and a key that is not a chapter', () => {
    const ended = stateOf({ revising: { 9: { chapter: 9, active: false, since: '2026-10-28T11:21:00Z' } } });
    expect(headStatusOf({ stages: stagesOf(), state: ended, nowMs: AT + 10_000 }).kind).toBe('idle');
    const passes = { 0: { passId: 'stp_a', changeId: null, stage: 'queued' as const } };
    const status = headStatusOf({ stages: { log: {}, passes }, state: stateOf(), nowMs: AT });
    expect(status.kind).toBe('idle');
  });
});
