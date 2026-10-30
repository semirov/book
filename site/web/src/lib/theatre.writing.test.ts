import { STATE_LINES, type CommentDto, type PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { AppliedWrite } from './clientState.ts';
import type { SentenceFilings } from './filings.ts';
import { STATE_WORDS } from './marginalia.ts';
import {
  decisionOf,
  failureOf,
  performedFiling,
  QUEUE_BEAT_MS,
  theatreOf,
  writtenBlocks,
  writtenRunOf,
  writingOf,
  type TheatreInput,
} from './theatre.ts';

/**
 * BOOK-227 §9.4 / BOOK-DOC-86 §2 — the **writing** act, on PR #121's write.
 *
 * The print is main's (`PrintPass`): this file proves only the theatre's own reading of it — the
 * act's clock is `chapter:applied.appliedAt`, its window is the print's (`PRINT_WINDOW_MS`), it
 * belongs to the block the write names and to no other, it prints nothing where the print itself
 * refuses a plan, and it gives way to the gates and to the sink in the §2 order.
 */

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const QUOTE = 'Комната 1-04 стояла в конце коридора, и дверь была приоткрыта.';
const BLOCK = 'ch01#0594465f';

function comment(overrides: Partial<CommentDto> & { status: CommentDto['status'] }): CommentDto {
  return {
    id: 'cmt_A7K',
    number: 12,
    chapter: 1,
    anchor: { blockId: BLOCK, blockIndex: 3, quote: QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'семиров',
    authorColor: '#000',
    body: 'текст',
    proposedText: null,
    interventionKind: 'document',
    status: 'batched',
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

function filingsOf(row_: CommentDto): SentenceFilings {
  return { blockId: BLOCK, quote: row_.anchor.quote, all: [row_], number: 'замечание 12', extra: 0, stale: false };
}

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

/** The page's own derivation (the row is the last decision it holds) plus the frame the case names. */
function input(overrides: Partial<TheatreInput> = {}): TheatreInput {
  const filings = overrides.filings === undefined ? filingsOf(comment({ status: 'batched' })) : overrides.filings;
  const row_ = performedFiling(filings);
  return {
    filings,
    reading: null,
    stages: null,
    decision: row_ === null ? null : decisionOf(row_),
    processing: false,
    failed: row_ === null ? null : failureOf(row_),
    applied: null,
    transport: 'up',
    now: T0,
    ...overrides,
  };
}

const write = (overrides: Partial<AppliedWrite> = {}): AppliedWrite => ({
  n: 1,
  rev: 16,
  appliedAt: T0,
  patch: [],
  patchTruncated: false,
  span: [{ blockId: BLOCK, before: 'было', after: 'стало', truncated: false }],
  ...overrides,
});

describe('BOOK-227 §9.4 — the writing act, on PR #121’s write', () => {
  it('is the print window on the block the write names', () => {
    const act = theatreOf(input({ applied: write(), now: T0 + 100 }));
    expect(act).toMatchObject({ kind: 'writing', since: T0 });
    expect(act?.kind === 'writing' ? act.blocks : []).toEqual([BLOCK]);
    // Past the print's own window (6 s) the text is simply there: no act, nothing replays.
    expect(theatreOf(input({ applied: write(), now: T0 + 6_000 }))).toBeNull();
  });

  it('is not performed for a block the write does not name', () => {
    const elsewhere = write({ span: [{ blockId: 'ch01#zzz', before: 'а', after: 'б', truncated: false }] });
    expect(theatreOf(input({ applied: elsewhere, now: T0 + 100 }))).toBeNull();
    expect(writingOf(elsewhere, BLOCK, T0 + 100)).toBeNull();
  });

  it('prints nothing when the print itself refuses the plan', () => {
    // A cut patch or a missing span is a guess: `appliedPrintPlans` plans no block, so neither
    // does the theatre (§121 `appliedPrint.ts`).
    expect(writtenBlocks(write({ patchTruncated: true }))).toEqual([]);
    expect(writtenBlocks(write({ span: null }))).toEqual([]);
    expect(theatreOf(input({ applied: write({ span: null }), now: T0 + 100 }))).toBeNull();
    // A truncated side is half a sentence, and it waits exactly as the print does.
    const half = write({ span: [{ blockId: BLOCK, before: 'б', after: 'с', truncated: true }] });
    expect(writtenBlocks(half)).toEqual([]);
    expect(theatreOf(input({ applied: half, now: T0 + 100 }))).toBeNull();
  });

  it('gives way to the gates, and the landing takes the sink', () => {
    const row_ = comment({
      status: 'applied',
      decidedAt: new Date(T0 - 60_000).toISOString(),
      applied: { chapter: 1, rev: 16 },
    });
    const before = [
      stage({ stage: 'drafting', at: T0 - 4_000 }),
      stage({ stage: 'verdict', stageSeq: 2, at: T0 - 400 }),
    ];
    // A gate that starts after the write is the round reading the new text: checking wins there,
    // because the page has no later fact than that gate.
    const after = [...before, stage({ stage: 'verdict', stageSeq: 3, at: T0 + 200 })];
    expect(theatreOf(input({ filings: filingsOf(row_), applied: write(), stages: after, now: T0 + 400 }))).toMatchObject({
      kind: 'checking',
      since: T0 + 200,
    });
    // Past the print's window the gates are behind the sink: the landing beat, clocked by the
    // write's own `appliedAt` and never by the acceptance a minute before it.
    const landing = theatreOf(input({ filings: filingsOf(row_), applied: write(), stages: before, now: T0 + 6_000 }));
    expect(landing).toMatchObject({ kind: 'landing', since: T0 });
    // Inside the window both carry `appliedAt`, and the ink outranks the mark it will leave.
    expect(theatreOf(input({ filings: filingsOf(row_), applied: write(), now: T0 + 100 }))).toMatchObject({
      kind: 'writing',
    });
  });

  it('names the run it wrote, cut the way the print cuts it', () => {
    // The span's `before`/`after` are the whole block (BOOK-DOC-84 §11.2): the run is the diff's,
    // the same one `PrintPass` inks — never the entry's own text.
    const whole = write({
      span: [{ blockId: BLOCK, before: 'Свет был не для меня.', after: 'Свет был только для камеры.', truncated: false }],
    });
    expect(writtenRunOf(whole, BLOCK)).toBe('только для камеры');
    expect(writtenRunOf(write(), BLOCK)).toBe('ста');
    // A removal has no new text: the run it took away is the one its struck lines stood on.
    expect(writtenRunOf(write({ span: [{ blockId: BLOCK, before: 'старое', after: '', truncated: false }] }), BLOCK)).toBe('старое');
    expect(writtenRunOf(write(), 'ch01#zzz')).toBeNull();
    expect(writtenRunOf(null, BLOCK)).toBeNull();
  });
});
