import { HEAD_WORDS, type PassStage, type PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { HEAD_SILENCE_MS, headStatusOf, type HeadState, type HeadStages, type HeadSocket } from './headStatus.ts';
import { inFlightOf, type StagesLog } from './useStages.ts';

/**
 * BOOK-218 — the head's one word, as a function of the facts the page already holds.
 *
 * The deck is the owner's: `тихо`, `правку читают`, `правка ждёт`, `главу пишут`, `главу
 * проверяют`, `внесено`, `связи нет` — one word about now, and nothing else. The old line
 * (`книга пишется · глава 12 · 14:21`) is deleted whole, so this file also proves that no chapter
 * and no clock can be rejoined to the word later. The 90 s boundary is exact: 90 000 ms is still
 * writing, 90 001 is `тихо`.
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
    queue: { processing: null, head: null, depth: 0 },
    revising: [],
    ...overrides,
  };
}

const head = (events: PassStageEvent[], nowMs = AT + 20_000, socket: HeadSocket = 'open') =>
  headStatusOf({ stages: stagesOf(...events), state: stateOf(), socket, nowMs });

describe('the head’s one word while a pass is in flight', () => {
  it('says «главу пишут» while the chapter is being drafted — no chapter, no clock, no stage', () => {
    const status = head([event('queued', 1), event('read', 2), event('drafting', 3)]);
    expect(status.kind).toBe('drafting');
    expect(status.full).toBe(HEAD_WORDS.drafting);
    expect(status.full).toBe('главу пишут');
    const printed = status.full;
    expect(printed).not.toContain('глава 12');
    expect(printed).not.toMatch(/\d{2}:\d{2}/u);
    expect(printed).not.toContain('проход');
    expect(printed).not.toMatch(/deepseek|flash|writer|модел|LLM/iu);
    expect(printed).toBe(printed.toLowerCase());
    // The timer counts from the newest fact, not from the pass's first one.
    expect(status.atMs).toBe(AT + 2_000);
  });

  it('says «правку читают» while the filing is read, and «главу проверяют» while the gates read', () => {
    const reading = head([event('queued', 1), event('read', 2)]);
    expect(reading.kind).toBe('reading');
    expect(reading.full).toBe('правку читают');
    const gates = head([event('read', 1), event('verdict', 2)]);
    expect(gates.kind).toBe('gates');
    expect(gates.full).toBe('главу проверяют');
    // The gate's own sentence is the word's detail, never a second visible line.
    expect(gates.detail).toBe('написанное читает редактор');
  });

  it('says «правка ждёт» while the pass only stands in line', () => {
    const queued = head([event('queued', 1)]);
    expect(queued.kind).toBe('waiting');
    expect(queued.full).toBe('правка ждёт');
  });

  it('says the same word whichever snapshot fact names the pass', () => {
    const processing = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ queue: { processing: { chapter: 7, startedAt: '2026-10-28T11:20:00Z' }, head: null, depth: 0 } }),
      socket: 'open',
      nowMs: AT + 30_000,
    });
    expect(processing.full).toBe('главу пишут');
    expect(processing.atMs).toBe(Date.parse('2026-10-28T11:20:00Z'));
    // The real start is the word's detail, on the site's clock (14:20 in Moscow).
    expect(processing.detail).toBe('главу пишут — начали в 14:20');
    const revising = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ revising: [{ chapter: 9, since: '2026-10-28T11:21:00Z' }] }),
      socket: 'open',
      nowMs: AT + 10_000,
    });
    expect(revising.full).toBe('главу пишут');
    // A pass whose stages never reached the page is still real; its clock is the snapshot's.
    const passes = { 12: { passId: 'stp_01J9Z8K4Q7', changeId: null, stage: 'queued' as const } };
    const missed = headStatusOf({ stages: { log: {}, passes }, state: stateOf(), socket: 'open', nowMs: AT + 3_000 });
    expect(missed.kind).toBe('waiting');
    expect(missed.atMs).toBe(Date.parse(WRITING));
  });
});

describe('the 90 s silence', () => {
  const silent = (nowMs: number) => head([event('drafting', 3)], nowMs);

  it('is still writing at 90 000 ms and quiet one millisecond later', () => {
    expect(silent(AT + 2_000 + HEAD_SILENCE_MS).kind).toBe('drafting');
    const idle = silent(AT + 2_000 + HEAD_SILENCE_MS + 1);
    expect(idle.kind).toBe('idle');
    expect(idle.full).toBe(HEAD_WORDS.idle);
    expect(idle.full).toBe('тихо');
    expect(idle.full).not.toContain('книга');
    expect(idle.full).not.toContain('глава');
    expect(idle.full).not.toMatch(/\d{2}:\d{2}/u);
    expect(idle.atMs).toBeNull();
  });

  it('is quiet the moment the engine reports it down or absent, however fresh the stage is', () => {
    for (const status of ['down', 'absent'] as const) {
      const held = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf({ engine: { status, heartbeatAt: WRITING } }),
        socket: 'open',
        nowMs: AT + 2_500,
      });
      expect(held.kind, status).toBe('idle');
      expect(held.full).toBe('тихо');
    }
    // `paused` and `throttled` are not a stopped engine: the pass may still land.
    for (const status of ['paused', 'throttled', 'unknown'] as const) {
      const held = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf({ engine: { status, heartbeatAt: WRITING } }),
        socket: 'open',
        nowMs: AT + 2_500,
      });
      expect(held.kind, status).toBe('drafting');
      expect(held.full).toBe('главу пишут');
    }
  });
});

describe('no pass in flight', () => {
  it('prints «тихо» — the explicit idle word, never an empty head', () => {
    const status = headStatusOf({ stages: stagesOf(), state: stateOf(), socket: 'open', nowMs: AT });
    expect(status).toEqual({ kind: 'idle', full: 'тихо', atMs: null, detail: null });
  });

  it('says «внесено» just after a landing, and «тихо» once the moment has passed', () => {
    const landed = head([event('drafting', 3), event('landed', 4)], AT + 5_000);
    expect(landed.kind).toBe('landed');
    expect(landed.full).toBe('внесено');
    expect(head([event('drafting', 3), event('landed', 4)], AT + 5_000 + HEAD_SILENCE_MS + 1).full).toBe('тихо');
  });

  it('says «правка ждёт» when the lane holds a change and nothing is writing', () => {
    const held = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ queue: { processing: null, head: { chapter: 7 }, depth: 2 } }),
      socket: 'open',
      nowMs: AT,
    });
    expect(held.kind).toBe('waiting');
    expect(held.full).toBe('правка ждёт');
  });

  it('says «связи нет» whenever the page has no live line — whatever else is true', () => {
    for (const socket of ['connecting', 'closed', 'capacity'] as const) {
      const offline = headStatusOf({
        stages: stagesOf(event('drafting', 3)),
        state: stateOf(),
        socket,
        nowMs: AT + 2_000,
      });
      expect(offline.kind, socket).toBe('offline');
      expect(offline.full).toBe('связи нет');
      // The word's detail is the sentence a reader gets on asking, never a second visible line.
      expect(offline.detail).toBe('нет связи: страница не знает, что сейчас происходит. обновите позже');
      expect(offline.atMs).toBeNull();
    }
    // A caller that holds no socket claims nothing about the line.
    expect(headStatusOf({ stages: stagesOf(), state: stateOf(), nowMs: AT }).kind).toBe('idle');
  });

  it('reads a finished log from its newest frame, and takes a state with no marks at all', () => {
    // A log with no fold: the head reads the frames themselves, newest first.
    const log = {
      12: [event('drafting', 1, { at: AT - 5_000 }), event('landed', 2), event('queued', 1, { at: AT - 6_000, passId: 'stp_old' })],
      // A chapter the log knows and holds nothing for is no frame at all — an empty list, and
      // (a caller's own log) a key with no list behind it.
      14: [],
      15: undefined,
    } as unknown as StagesLog;
    const status = headStatusOf({
      stages: { log, passes: {} },
      state: stateOf(),
      socket: 'open',
      nowMs: AT + 2_500,
    });
    expect(status.kind).toBe('landed');
    // A state object that never carried `revising` is a state with no marks, not an error.
    expect(headStatusOf({ stages: stagesOf(), state: { engine: { status: 'running', heartbeatAt: null } }, nowMs: AT }).kind).toBe('idle');
  });

  it('reads a lane the page only counted: depth without a head is a wait', () => {
    const counted = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ queue: { processing: null, depth: 2 } }),
      nowMs: AT,
    });
    expect(counted.kind).toBe('waiting');
    expect(counted.full).toBe('правка ждёт');
    // A queue object that answers with an explicit `null` head and no depth is quiet.
    expect(headStatusOf({ stages: stagesOf(), state: stateOf({ queue: { processing: null, head: null } }), nowMs: AT }).kind).toBe('idle');
  });

  it('reads the newest fact of two passes in flight, never an older frame', () => {
    const later = stagesOf(event('drafting', 3), event('drafting', 1, { chapter: 14, at: AT - 5_000 }));
    const status = headStatusOf({ stages: later, state: stateOf(), socket: 'open', nowMs: AT + 20_000 });
    expect(status.kind).toBe('drafting');
    expect(status.atMs).toBe(AT + 2_000);
    // …and the other way round: the first chapter read is the older one.
    const earlier = stagesOf(event('drafting', 1, { at: AT - 5_000 }), event('drafting', 3, { chapter: 14 }));
    expect(headStatusOf({ stages: earlier, state: stateOf(), socket: 'open', nowMs: AT + 20_000 }).atMs).toBe(
      AT + 2_000,
    );
  });

  it('takes a processing change with no start moment the page can read', () => {
    const status = headStatusOf({
      stages: stagesOf(),
      state: stateOf({ queue: { processing: { chapter: 7 }, head: null, depth: 0 } }),
      socket: 'open',
      nowMs: AT,
    });
    expect(status.kind).toBe('drafting');
    expect(status.detail).toBeNull();
    expect(status.atMs).toBe(Date.parse(WRITING));
  });

  it('never prints a moment the page cannot parse', () => {
    const unreadable = headStatusOf({
      stages: stagesOf(),
      state: stateOf({
        engine: { status: 'running', heartbeatAt: 'not-a-moment' },
        queue: { processing: { chapter: 7, startedAt: 'not-a-moment' }, head: null, depth: 0 },
      }),
      nowMs: AT,
    });
    // The pass is real and its clock is unknown: the word stands, and no `—` rides along.
    expect(unreadable.kind).toBe('drafting');
    expect(unreadable.detail).toBeNull();
    expect(unreadable.atMs).toBeNull();
  });

  it('prints the quiet word for a new book and for a missing log', () => {
    expect(
      headStatusOf({ stages: stagesOf(), state: stateOf({ engine: { status: 'absent', heartbeatAt: null } }), nowMs: AT })
        .kind,
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
