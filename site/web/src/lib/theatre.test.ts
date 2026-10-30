import { STATE_LINES, type CommentDto, type PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { SentenceFilings } from './filings.ts';
import { STATE_WORDS } from './marginalia.ts';
import {
  decisionOf,
  failureOf,
  groupsOf,
  inkedAt,
  MAX_TALLIES,
  QUEUE_BEAT_MS,
  SWEEP_FLOOR_MS,
  performedFiling,
  sweepOf,
  talliesOf,
  tallyMs,
  theatreOf,
  wordMsOf,
  wordsOf,
  type TheatreInput,
  type TheatreReading,
} from './theatre.ts';

/**
 * BOOK-227 / BOOK-DOC-86 §2, §9 — the theatre's state machine, as a table.
 *
 * Every row is one frame and the act it must produce. The negative rows are the point of the
 * machine: no frame means no act (a sentence nobody is reading has none), a pass that only
 * read starts nothing, a late reader replays nothing, and a terminal sink is never undone by a
 * stale one that arrives 12 ms behind it.
 */

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const QUOTE = 'Комната 1-04 стояла в конце коридора, и дверь была приоткрыта.';

function comment(overrides: Partial<CommentDto> & { status: CommentDto['status'] }): CommentDto {
  return {
    id: 'cmt_A7K',
    number: 12,
    chapter: 1,
    anchor: {
      blockId: 'ch01#0594465f',
      blockIndex: 3,
      quote: QUOTE,
      prefix: null,
      suffix: null,
      resolved: true,
    },
    author: 'семиров',
    authorColor: '#000',
    body: 'текст',
    proposedText: null,
    interventionKind: 'document',
    refusal: null,
    frame: null,
    premise: false,
    changeStatus: null,
    reason: null,
    attempt: null,
    createdAt: new Date(T0 - 60_000).toISOString(),
    decidedAt: null,
    changeId: 'chg_1',
    applied: null,
    ...overrides,
  };
}

function filingsOf(row: CommentDto): SentenceFilings {
  return { blockId: 'ch01#0594465f', quote: row.anchor.quote, all: [row], number: '№A7K', extra: 0, stale: false };
}

/** A read's claim, as `lib/filingLive.ts` publishes `filing:reading{claimed}` (BOOK-220 §11.3). */
const claimed = (at = T0): TheatreReading => ({ phase: 'claimed', since: at, deadlineAt: at + 900_000 });

function stage(overrides: Partial<PassStageEvent>): PassStageEvent {
  return {
    passId: 'stp_1',
    chapter: 1,
    stageSeq: 1,
    stage: 'read',
    at: T0,
    actor: { process: 'writer', model: null },
    changeId: 'chg_1',
    summary: 'читает',
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

/**
 * The page's own derivation (the row is the last decision it holds) plus the frame the test
 * names: a case supplies the row, and the decision and the failure follow from it, exactly as
 * `SentenceTheatre` reads them.
 */
function input(overrides: Partial<TheatreInput> = {}): TheatreInput {
  const filings = overrides.filings === undefined ? filingsOf(comment({ status: 'batched' })) : overrides.filings;
  const row = performedFiling(filings);
  return {
    filings,
    reading: null,
    stages: null,
    decision: row === null ? null : decisionOf(row),
    processing: false,
    failed: row === null ? null : failureOf(row),
    applied: null,
    transport: 'up',
    now: T0,
    ...overrides,
  };
}

describe('BOOK-227 — the acts, one frame at a time', () => {
  it('arrival: the live claim, and only the live claim', () => {
    const act = theatreOf(input({ reading: claimed(), now: T0 + 1_000 }));
    expect(act).toMatchObject({ kind: 'arrival', since: T0, deadlineAt: T0 + 900_000 });
    expect(act?.kind === 'arrival' ? act.words : 0).toBe(wordsOf(QUOTE).length);
  });

  it('arrival is not the reader’s own post: a fresh row with no claim has no act', () => {
    expect(theatreOf(input({ filings: filingsOf(comment({ status: 'new' })) }))).toBeNull();
    // A delivered row (a hand-off is not a reading) still has no act without a claim.
    expect(theatreOf(input({ filings: filingsOf(comment({ status: 'delivered' })) }))).toBeNull();
  });

  it('thinking: drafting, while the pass is open', () => {
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted' })),
        stages: [stage({ stage: 'drafting', at: T0 + 10_000 })],
        now: T0 + 11_000,
      }),
    );
    expect(act).toMatchObject({ kind: 'thinking', since: T0 + 10_000 });
  });

  it('thinking carries the stage’s deadline only when the frame has one', () => {
    const stageAt = T0 + 10_000;
    const withDeadline = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted' })),
        stages: [{ ...stage({ stage: 'drafting', at: stageAt }), deadlineAt: stageAt + 480_000 } as PassStageEvent],
        now: stageAt + 1_000,
      }),
    );
    expect(withDeadline).toMatchObject({ kind: 'thinking', deadlineAt: stageAt + 480_000 });
    const without = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted' })),
        stages: [stage({ stage: 'drafting', at: stageAt })],
        now: stageAt + 1_000,
      }),
    );
    expect(without).toMatchObject({ kind: 'thinking', deadlineAt: null });
  });

  it('thinking yields to the round’s gate, the later stage of the same pass', () => {
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', changeId: 'chg_1' })),
        stages: [
          stage({ stage: 'drafting', at: T0 + 10_000 }),
          stage({ stage: 'verdict', stageSeq: 2, at: T0 + 20_000 }),
        ],
        now: T0 + 21_000,
      }),
    );
    expect(act).toMatchObject({ kind: 'checking', tallies: 1, since: T0 + 20_000 });
  });

  it('a pass that only read starts nothing', () => {
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted' })),
        stages: [stage({ stage: 'read', at: T0 }), stage({ stage: 'queued', at: T0, stageSeq: 0 })],
        now: T0 + 5_000,
      }),
    );
    // The accepted row is an old (unwitnessed) decision here, so nothing is performed.
    expect(act).toBeNull();
  });

  it('verdict: accepted, held and refused are three shapes of one act', () => {
    const at = new Date(T0).toISOString();
    const accepted = theatreOf(
      input({ filings: filingsOf(comment({ status: 'accepted', decidedAt: at })), now: T0 + 100 }),
    );
    // The word is the row's own (BOOK-218 vocabulary): accepted, the lane not there yet —
    // «принято», never the waiting word.
    expect(accepted).toMatchObject({ kind: 'verdict', outcome: 'accepted', word: STATE_WORDS.accepted });
    const working = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', changeStatus: 'processing', decidedAt: at })),
        processing: true,
        now: T0 + 100,
      }),
    );
    expect(working).toMatchObject({ kind: 'verdict', outcome: 'accepted', word: STATE_WORDS.writing });
    // The verdict's own beat is 120 + 400 ms; the queue's stillness begins after it, never in it.
    const still = theatreOf(
      input({ filings: filingsOf(comment({ status: 'accepted', decidedAt: at })), now: T0 + QUEUE_BEAT_MS }),
    );
    expect(still).toMatchObject({ kind: 'queue' });

    const held = theatreOf(
      input({ filings: filingsOf(comment({ status: 'quarantined', decidedAt: at })), now: T0 + 100 }),
    );
    // A hold is «проверяется» with the deck's line under it (§BOOK-61: a hold is not a state word).
    expect(held).toMatchObject({ kind: 'verdict', outcome: 'held', word: STATE_WORDS.held });
    expect(held?.kind === 'verdict' ? held.detail : '').toBe(STATE_LINES.held);

    const refused = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'rejected', refusal: 'rights', decidedAt: at, reason: 'не принято: не по книге' })),
        now: T0 + 100,
      }),
    );
    expect(refused).toMatchObject({ kind: 'verdict', outcome: 'refused', word: 'не принято' });
  });

  it('queue: an accepted filing the lane has not reached — and no queue while it holds it', () => {
    const at = new Date(T0).toISOString();
    const waiting = theatreOf(
      input({ filings: filingsOf(comment({ status: 'accepted', decidedAt: at })), now: T0 + QUEUE_BEAT_MS }),
    );
    expect(waiting).toMatchObject({ kind: 'queue', since: T0 + QUEUE_BEAT_MS, ahead: null });

    const held = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', decidedAt: at })),
        processing: true,
        now: T0 + 500,
      }),
    );
    expect(held).toMatchObject({ kind: 'verdict', outcome: 'accepted' });
  });

  it('checking: the round’s gates, one tally each, up to three', () => {
    const gates = [
      stage({ stage: 'verdict', stageSeq: 5, at: T0 + 1_000 }),
      stage({ stage: 'verdict', stageSeq: 6, at: T0 + 2_000 }),
    ];
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', changeId: 'chg_1' })),
        stages: gates,
        now: T0 + 3_000,
      }),
    );
    expect(act).toMatchObject({ kind: 'checking', tallies: 2 });
    // Never more than three strokes: a round accumulates, it does not grow a fourth.
    const many = [...Array(5)].map((_, index) =>
      stage({ stage: 'verdict', stageSeq: 10 + index, at: T0 + 1_000 + index }),
    );
    const capped = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', changeId: 'chg_1' })),
        stages: many,
        now: T0 + 9_000,
      }),
    );
    expect(capped?.kind === 'checking' ? capped.tallies : -1).toBe(MAX_TALLIES);
  });

  it('a round that only read draws no gate', () => {
    expect(talliesOf(null)).toBe(0);
    expect(talliesOf([stage({ stage: 'read', at: T0 })])).toBe(0);
    expect(talliesOf([stage({ stage: 'drafting', at: T0 })])).toBe(0);
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', changeId: 'chg_1' })),
        stages: [stage({ stage: 'read', at: T0 + 1_000 })],
        now: T0 + 2_000,
      }),
    );
    expect(act).toBeNull();
  });

  it('checking yields to landing, the later sink', () => {
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'applied', changeId: 'chg_1', decidedAt: new Date(T0 + 5_000).toISOString() })),
        stages: [stage({ stage: 'verdict', at: T0 + 1_000 })],
        now: T0 + 6_000,
      }),
    );
    expect(act).toMatchObject({ kind: 'landing', word: 'внесено' });
  });

  it('failed our fault: the record’s own empty attempt', () => {
    const at = new Date(T0).toISOString();
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', attempt: 'failed', decidedAt: at })),
        now: T0 + 500,
      }),
    );
    expect(act).toMatchObject({ kind: 'failed', cause: 'fault' });
  });

  it('failed is not overwritten by the queue’s beat: at +520 and at +3 000 it stays failed', () => {
    const at = new Date(T0).toISOString();
    const failedRow = () =>
      filingsOf(comment({ status: 'accepted', attempt: 'failed', decidedAt: at, reason: 'модель не ответила' }));
    for (const now of [T0 + QUEUE_BEAT_MS, T0 + 3_000]) {
      const act = theatreOf(input({ filings: failedRow(), now }));
      expect(act, `at +${String(now - T0)} ms`).toMatchObject({ kind: 'failed', cause: 'fault' });
      // …and the note's sentence is the record's own, so the word and the line agree.
      expect(act?.kind === 'failed' ? act.detail.length : 0).toBeGreaterThan(0);
    }
    // A row with no failed attempt still queues after the verdict's beat.
    const queued = theatreOf(
      input({ filings: filingsOf(comment({ status: 'accepted', decidedAt: at })), now: T0 + QUEUE_BEAT_MS }),
    );
    expect(queued).toMatchObject({ kind: 'queue' });
  });

  it('failed a verdict: refused after text was live', () => {
    const at = new Date(T0).toISOString();
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'rejected', refusal: 'auditor', decidedAt: at, reason: 'отклонено' })),
        now: T0 + 500,
      }),
    );
    expect(act).toMatchObject({ kind: 'verdict', outcome: 'refused' });
  });

  it('transport down: marks stop and no per-sentence mark is added', () => {
    const act = theatreOf(input({ reading: claimed(), transport: 'down', now: T0 + 1_000 }));
    expect(act).toMatchObject({ kind: 'failed', cause: 'transport' });
  });

  it('a filing with no sentence has no act', () => {
    const row = comment({ status: 'batched' });
    row.anchor.quote = null;
    expect(theatreOf(input({ filings: filingsOf(row), reading: claimed() }))).toBeNull();
    expect(theatreOf(input({ filings: null, reading: claimed() }))).toBeNull();
    // A stale anchor stands on nothing either, even with a live claim.
    expect(theatreOf(input({ filings: { ...filingsOf(row), stale: true }, reading: claimed() }))).toBeNull();
  });

  it('a read that already ended starts nothing', () => {
    const act = theatreOf(
      input({ reading: { ...claimed(), phase: 'read', deadlineAt: null }, now: T0 + 1_000 }),
    );
    expect(act).toBeNull();
  });

  it('a group with no rows performs nothing', () => {
    expect(performedFiling({ blockId: 'b', quote: 'текст', all: [], number: '№A7K', extra: 0, stale: false })).toBeNull();
  });

  it('a late reader replays nothing', () => {
    const old = new Date(T0 - 3_600_000).toISOString();
    const act = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'accepted', decidedAt: old })),
        now: T0,
      }),
    );
    expect(act).toBeNull();
  });

  it('the 12 ms landed → refused: the later sink wins in place', () => {
    const landed = new Date(T0).toISOString();
    const refused = new Date(T0 + 12).toISOString();
    const act = theatreOf(
      input({
        // The row the page holds after the second frame: one status, no history.
        filings: filingsOf(comment({ status: 'rejected', refusal: 'rights', decidedAt: refused })),
        now: T0 + 12,
      }),
    );
    expect(act).toMatchObject({ kind: 'verdict', outcome: 'refused' });
    // And the same two facts in the other order end in the landing, not in a leave.
    const newer = theatreOf(
      input({
        filings: filingsOf(comment({ status: 'applied', decidedAt: refused })),
        now: T0 + 12,
      }),
    );
    expect(newer).toMatchObject({ kind: 'landing' });
    expect(landed.length).toBeGreaterThan(0);
  });
});

describe('BOOK-227 — the numbers of §9', () => {
  it('sweep: 57 words is 14 869 ms; the floor is 1 200; no ceiling', () => {
    expect(sweepOf(57)).toBe(14_869);
    expect(sweepOf(2)).toBe(SWEEP_FLOOR_MS);
    expect(sweepOf(1)).toBe(SWEEP_FLOOR_MS);
    expect(sweepOf(0)).toBe(SWEEP_FLOOR_MS);
    // A 15-minute paragraph is drawn in full: the tempo rule outranks every later branch.
    expect(sweepOf(3_450)).toBe(900_000);
  });

  it('one press per word: wordMs is never below 260.87, and the batching branch is 1', () => {
    const sweep = sweepOf(57);
    const wordMs = wordMsOf(sweep, 57);
    expect(wordMs).toBeGreaterThan(260);
    expect(wordMs).toBeLessThan(261);
    expect(groupsOf(wordMs)).toBe(1);
    // The floor is the only thing that can slow a word below 230 wpm, and that is its job.
    expect(groupsOf(wordMsOf(SWEEP_FLOOR_MS, 1))).toBe(1);
    expect(groupsOf(10)).toBe(9);
  });

  it('the fill follows the clock: k = min(n, floor(e·n/sweep) + 1)', () => {
    const sweep = sweepOf(57);
    expect(inkedAt(0, sweep, 57)).toBe(1);
    expect(inkedAt(-50, sweep, 57)).toBe(1);
    expect(inkedAt(sweep, sweep, 57)).toBe(57);
    expect(inkedAt(sweep * 2, sweep, 57)).toBe(57);
    // Scrolling away and back joins where the time says: half the sweep is half the words + 1.
    expect(inkedAt(sweep / 2, sweep, 57)).toBe(29);
    expect(inkedAt(0, sweep, 0)).toBe(0);
  });

  it('the tally is its height’s: 120 ms a line, clamped to 240–1 200', () => {
    expect(tallyMs(0)).toBe(240);
    expect(tallyMs(1)).toBe(240);
    expect(tallyMs(2)).toBe(240);
    expect(tallyMs(3)).toBe(360);
    expect(tallyMs(10)).toBe(1_200);
    expect(tallyMs(40)).toBe(1_200);
  });

  it('words are the pen’s step, in order, with their offsets', () => {
    expect(wordsOf('  Комната 1-04 стояла ')).toEqual([
      { start: 2, end: 9 },
      { start: 10, end: 14 },
      { start: 15, end: 21 },
    ]);
  });
});

describe('BOOK-227 — which filing a sentence performs', () => {
  it('the alive one wins the slot, as the numeral does', () => {
    const alive = comment({ status: 'accepted', id: 'cmt_LIVE' });
    const gone = comment({ status: 'applied' });
    const filings: SentenceFilings = { ...filingsOf(alive), all: [gone, alive], extra: 1 };
    expect(performedFiling(filings)?.id).toBe('cmt_LIVE');
    expect(performedFiling(null)).toBeNull();
  });
});
