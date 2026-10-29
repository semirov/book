import type { PassStage, PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { MIDDOT } from './format.ts';
import { HEAD_SILENCE_MS, headStatusOf, type HeadState, type HeadStages } from './headStatus.ts';
import { inFlightOf, type StagesLog } from './useStages.ts';

/**
 * The head's one line, as a function of the facts the page already holds (BOOK-156 #3814).
 *
 * The three states and their words are the owner's, so they are asserted literally — a paraphrase
 * is the defect this file exists for («проход», a model id, a second name for a pass). The 90 s
 * boundary is exact: 90 000 ms is still writing, 90 001 is not.
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

describe('the head’s state while a pass is in flight', () => {
  it('says the book is being written, with the chapter and the latest stage’s time', () => {
    const status = live(event('queued', 1), event('read', 2), event('drafting', 3));
    expect(status.kind).toBe('live');
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 12${MIDDOT}14:21`);
    // One line and no second variant: the phone does not paint the state at all (BOOK-199).
    expect(status).not.toHaveProperty('short');
    // The timer counts from the newest fact, not from the pass's first one.
    expect(status.atMs).toBe(AT + 2_000);
  });

  it('takes the chapter of the pass in flight, whichever chapter was read last before it', () => {
    const status = live(
      event('landed', 4, { chapter: 11, at: AT + 60_000 }),
      event('drafting', 3, { chapter: 12 }),
    );
    expect(status.kind).toBe('live');
    expect(status.full).toContain(`глава 12`);
    expect(status.full).not.toContain('глава 11');
  });

  it('takes the newest stage of one pass when two frames share a moment', () => {
    // The same millisecond, two stages: the sequence decides, not the arrival order.
    const status = live(event('drafting', 3), event('verdict', 3, { stage: 'verdict', stageSeq: 4 }));
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 12${MIDDOT}14:21`);
    expect(status.atMs).toBe(AT + 2_000);
  });

  it('says a pass is in flight even when its own stages never reached the page', () => {
    // A fold from frames that arrived before the log was mounted: the pass is real, the clock is
    // the snapshot's. This is the one input where the head has a chapter and no stage.
    const passes = { 12: { passId: 'stp_01J9Z8K4Q7', changeId: null, stage: 'queued' as const } };
    const status = headStatusOf({ stages: { log: {}, passes }, state: stateOf(), nowMs: AT + 3_000 });
    expect(status.kind).toBe('live');
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 12${MIDDOT}14:21`);
    expect(status.atMs).toBe(Date.parse(WRITING));
  });

  it('drops the place when the fact that names it carries no chapter', () => {
    const status = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ revising: [{ since: '2026-10-28T11:21:00Z' }] }),
      nowMs: AT + 10_000,
    });
    expect(status.full).toBe(`книга пишется${MIDDOT}14:21`);
  });

  it('names no model, no role and no second word for a pass', () => {
    const status = live(event('drafting', 3));
    const printed = status.full ?? '';
    expect(printed).not.toContain('проход');
    expect(printed).not.toMatch(/deepseek|flash|writer|модел/iu);
    // Lowercase, as the owner asked: no label shout on the reading surface.
    expect(printed).toBe(printed.toLowerCase());
  });
});

describe('the 90 s silence', () => {
  const silent = (nowMs: number) =>
    headStatusOf({ stages: stagesOf(event('drafting', 3)), state: stateOf(), nowMs });

  it('is still writing at 90 000 ms and stopped one millisecond later', () => {
    expect(silent(AT + 2_000 + HEAD_SILENCE_MS).kind).toBe('live');
    const stopped = silent(AT + 2_000 + HEAD_SILENCE_MS + 1);
    expect(stopped.kind).toBe('stopped');
    // The book's own sentence, on the live line's verb: no «движок», no stage name.
    expect(stopped.full).toBe(`книга не пишется${MIDDOT}14:21`);
    expect(stopped.full).not.toContain('движок');
    expect(stopped.atMs).toBe(AT + 2_000);
  });

  it('is stopped the moment the engine reports it down or absent, however fresh the stage is', () => {
    for (const status of ['down', 'absent'] as const) {
      const held = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf({ engine: { status, heartbeatAt: WRITING } }),
        nowMs: AT + 2_500,
      });
      expect(held.kind, status).toBe('stopped');
      expect(held.full).toBe(`книга не пишется${MIDDOT}14:21`);
    }
    // `paused` and `throttled` are not a stopped engine: the pass may still land.
    for (const status of ['paused', 'throttled', 'unknown'] as const) {
      const held = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf({ engine: { status, heartbeatAt: WRITING } }),
        nowMs: AT + 2_500,
      });
      expect(held.kind, status).toBe('live');
    }
  });
});

describe('no pass in flight', () => {
  it('prints nothing at all, and the foot’s grip keeps the fact', () => {
    const status = headStatusOf({ stages: stagesOf(), state: stateOf(), nowMs: AT });
    expect(status).toEqual({ kind: 'idle', full: null, atMs: null });
  });

  it('prints nothing for a new book: no stage ever ran and no mark is held', () => {
    const status = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ engine: { status: 'absent', heartbeatAt: null } }),
      nowMs: AT,
    });
    expect(status.kind).toBe('idle');
    // «пока не писалась» is the grip's word, not the head's.
    expect(status.full).toBeNull();
  });

  it('prints nothing for a pass that landed: the log remembers it, the head does not', () => {
    const status = headStatusOf({
      stages: stagesOf(event('drafting', 3), event('landed', 4)),
      state: stateOf(),
      nowMs: AT + 5_000,
    });
    expect(status.kind).toBe('idle');
  });

  it('says nothing when the snapshot holds no revision mark either — null or absent', () => {
    expect(headStatusOf({ stages: stagesOf(), state: stateOf({ revising: null }), nowMs: AT }).kind).toBe('idle');
    const bare: HeadState = { engine: { status: 'running', heartbeatAt: null }, queue: null };
    expect(headStatusOf({ stages: stagesOf(), state: bare, nowMs: AT }).kind).toBe('idle');
  });

  it('says nothing without a log at all: PassRecordPage mounts the head with no stages', () => {
    expect(headStatusOf({ stages: undefined, state: stateOf(), nowMs: AT }).kind).toBe('idle');
    expect(headStatusOf({ stages: null, state: stateOf(), nowMs: AT }).kind).toBe('idle');
  });
});

describe('the facts the snapshot carries when the frames were missed', () => {
  it('reads a change the queue is processing, with its own start', () => {
    const status = headStatusOf({
      stages: stagesOf(),
      state: stateOf({
        queue: { processing: { chapter: 7, startedAt: '2026-10-28T11:20:00Z' } },
      }),
      nowMs: AT + 30_000,
    });
    expect(status.kind).toBe('live');
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 7${MIDDOT}14:20`);
    expect(status.atMs).toBe(Date.parse('2026-10-28T11:20:00Z'));
  });

  it('reads a block carrying the revision mark, and ignores one that is not active', () => {
    const state = stateOf({ revising: [{ chapter: 9, since: '2026-10-28T11:21:00Z' }] });
    const status = headStatusOf({ stages: stagesOf(), state, nowMs: AT + 10_000 });
    expect(status.kind).toBe('live');
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 9${MIDDOT}14:21`);
    // The page's frames are a chapter → mark record; a live one reads the same way.
    const held = stateOf({ revising: { 9: { chapter: 9, active: true, since: '2026-10-28T11:21:00Z' } } });
    expect(headStatusOf({ stages: stagesOf(), state: held, nowMs: AT + 10_000 }).full).toBe(
      `книга пишется${MIDDOT}глава 9${MIDDOT}14:21`,
    );
    // ...and an ended mark is not a pass in flight.
    const ended = stateOf({ revising: { 9: { chapter: 9, active: false, since: '2026-10-28T11:21:00Z' } } });
    expect(headStatusOf({ stages: stagesOf(), state: ended, nowMs: AT + 10_000 }).kind).toBe('idle');
  });

  it('ignores a key that is not a chapter and a pass that names none', () => {
    // A fold from the wire is not trusted blindly: a key that is not 1..42 is skipped, not printed.
    const passes = {
      0: { passId: 'stp_a', changeId: null, stage: 'queued' as const },
      12: { passId: 'stp_b', changeId: null, stage: 'drafting' as const },
    };
    const log: StagesLog = { 12: [event('drafting', 3)] };
    const status = headStatusOf({ stages: { log, passes }, state: stateOf(), nowMs: AT + 3_000 });
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 12${MIDDOT}14:21`);
    // A processing change with no chapter: the fact stands, the place does not.
    const placeless = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ queue: { processing: { startedAt: '2026-10-28T11:20:00Z' } } }),
      nowMs: AT + 30_000,
    });
    expect(placeless.full).toBe(`книга пишется${MIDDOT}14:20`);
  });

  it('a stale queue start is a stopped engine, not a quiet one', () => {
    const status = headStatusOf({
      stages: stagesOf(),
      state: stateOf({
        engine: { status: 'running', heartbeatAt: '2026-10-28T11:19:00Z' },
        queue: { processing: { chapter: 7, startedAt: '2026-10-28T11:15:00Z' } },
      }),
      nowMs: AT,
    });
    expect(status.kind).toBe('stopped');
    expect(status.full).toBe(`книга не пишется${MIDDOT}14:15`);
  });

  it('drops the clock when nothing in the state carries a moment', () => {
    const status = headStatusOf({
      stages: stagesOf(),
      state: stateOf({
        engine: { status: 'running', heartbeatAt: null },
        revising: [{ chapter: 9 }],
      }),
      nowMs: AT,
    });
    expect(status.kind).toBe('live');
    expect(status.full).toBe(`книга пишется${MIDDOT}глава 9`);
    expect(status.atMs).toBeNull();
    // A broken stamp is no moment either: nothing is printed rather than «—».
    const broken = headStatusOf({
      stages: stagesOf(),
      state: stateOf({
        engine: { status: 'running', heartbeatAt: 'not a date' },
        revising: [{ chapter: 9 }],
      }),
      nowMs: AT,
    });
    expect(broken.full).toBe(`книга пишется${MIDDOT}глава 9`);
  });
});
