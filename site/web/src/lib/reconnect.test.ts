import type {
  ChapterAppliedPayload,
  HelloPayload,
  LivePass,
  LivePayload,
  PassStageEvent,
  StateSnapshot,
} from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { ClientState } from './clientState.ts';
import { EMPTY_COMPOSER } from './composer.ts';
import { applyFrame } from './frames.ts';
import { AT, BOOK, NOW, STATE, applied, resetSeq, start } from './framesFixtures.ts';
import { nowStateOf } from './nowState.ts';

/**
 * BOOK-DOC-84 §3.3/§11.1 — **the reconnect is a resync, and the record is not stale.**
 *
 * A page that loses its socket misses whatever the hub broadcast meanwhile: the hello it gets on
 * the next connection *is* the snapshot (`live` included), so the three missed frames must be
 * read back from it, not invented by the page. And a frame the page already applied must not be
 * applied twice when the same write rides in on the new `live.applied`: the applied cursor (the
 * write's own `rev`/`hseq`) already refuses it — this test pins that, because a second apply
 * would print the write again mid-sentence.
 */

/** 17:04 in Moscow — the contract's own example time, a minute after the fixtures' `AT`. */
const T = Date.parse('2026-10-29T14:04:00Z');
const MINUTE = 60_000;

const pass = (overrides: Partial<LivePass> = {}): LivePass => ({
  chapter: 3,
  passId: 'stp_1',
  changeId: 'chg_2',
  lane: 'forward',
  stage: 'drafting',
  stageSeq: 3,
  since: T,
  deadlineAt: T + 225 * MINUTE,
  attempt: 1,
  maxAttempts: 5,
  ...overrides,
});

/** The page's live block before the socket dropped: a filing is queued, a pass writes. */
const BEFORE: LivePayload = {
  at: new Date(T).toISOString(),
  passes: [pass()],
  applied: null,
  queue: { depth: 1, pending: [{ id: 'chg_2', chapter: 3, seq: 2, ahead: 0, kind: 'edit', enqueuedAt: NOW }] },
  filings: [{ commentId: 'cmt_1', chapter: 3, state: 'accepted', attempts: 1, attemptsLeft: 2, changeId: 'chg_2', at: NOW }],
  lane: { passesToday: 2, maxPasses: 4, writerAt: NOW },
};

/** The write the page did not see (the third missed frame). */
const WRITE: ChapterAppliedPayload = { ...applied, appliedAt: T + 2 * MINUTE };

/** The three frames it missed, as the hub's own `live` block reads them back. */
const AFTER: LivePayload = {
  at: new Date(T + 5 * MINUTE).toISOString(),
  passes: [
    pass({
      stage: 'verdict',
      stageSeq: 4,
      since: T + 4 * MINUTE,
      deadlineAt: T + 4 * MINUTE + 30 * MINUTE,
      gate: 'editor',
      round: 1,
    }),
  ],
  applied: { n: WRITE.n, rev: WRITE.rev, appliedAt: WRITE.appliedAt, patch: WRITE.patch, patchTruncated: false, span: WRITE.span },
  queue: { depth: 0, pending: [] },
  // The change was decided (the first missed frame) and the write is why.
  filings: [{ commentId: 'cmt_1', chapter: 3, state: 'applied', attempts: 1, attemptsLeft: 2, changeId: 'chg_2', at: NOW }],
  lane: { passesToday: 3, maxPasses: 4, writerAt: null },
};

function hello(live: LivePayload, state: StateSnapshot = STATE): HelloPayload {
  return {
    connId: `c${live.at}`,
    protocolVersion: 4,
    serverTime: NOW,
    limits: { commentsPerHour: 5, maxCommentChars: 1_200, maxEditChars: 800, queueSoftCap: 50, maxConnections: 500, perIp: 8, editSubmissionsPerDay: 3, maxWave: 2 },
    viewer: { signedIn: false, displayName: null },
    composer: EMPTY_COMPOSER,
    front: { title: 'Бланк', about: null, rev: 1, imprint: { author: 'А', copyright: '© А' }, authors: { count: 1, measuredAt: NOW } },
    catalog: BOOK.catalog,
    state,
    live,
    currentChapter: null,
    comments: { open: 0 },
  };
}

/** One connection: the hello, and the connector's own seq starts at 0 every time. */
function open(state: ClientState, live: LivePayload, seq = 1): ClientState {
  return applyFrame(state, { v: 1, type: 'hello', seq, ts: NOW, data: hello(live) } as never).state;
}

const at = (state: ClientState, nowMs: number): string | null => nowStateOf({ state, nowMs }).line;

describe('§3.3 — the reconnect heals the three frames the page missed', () => {
  it('reads the decision, the stage and the write back from the new hello', () => {
    resetSeq();
    const before = open(start(), BEFORE);
    expect(at(before, T)).toBe('машина пишет главу 3 · правка 002 · попытка 1 из 5 · 17:04');
    expect(before.applied).toBeNull();
    expect(before.filings[0]?.state).toBe('accepted');

    // The socket drops here. The frames it did not see: a change was decided, the pass reached
    // its gate round, and a write landed. The next connection's hello carries all three.
    const after = open(before, AFTER);

    // 1 — the decision: the viewer's own filing is now applied, and the queue is empty.
    expect(after.filings[0]?.state).toBe('applied');
    expect(after.queue).toHaveLength(0);
    // 2 — the stage: the pass is at its gate round, seeded from `live.passes`, never emptied.
    // The log is keyed by chapter; the newest event for the pass is the gate round.
    const stage = (after.stages[3] ?? []).filter((event) => event.passId === 'stp_1').at(-1) as
      | PassStageEvent
      | undefined;
    expect(stage?.stage).toBe('verdict');
    expect(stage?.stageSeq).toBe(4);
    // 3 — the write: `live.applied` is the block the print plans its ink from.
    expect(after.applied?.rev).toBe(WRITE.rev);
    expect(after.applied?.appliedAt).toBe(WRITE.appliedAt);
  });

  it('prints the healed state, not the state the dead socket left behind', () => {
    resetSeq();
    const after = open(open(start(), BEFORE), AFTER);
    const line = at(after, T + 4 * MINUTE) ?? '';
    // The newest frame wins: the gate round started after the write, so the line is the round.
    expect(line).toContain('машина проверяет главу 3');
    expect(line).not.toContain('машина пишет главу 3');
    expect(line).not.toContain('связи нет');
  });

  it('applies nothing twice when the same write and stage ride in again', () => {
    resetSeq();
    const after = open(open(start(), BEFORE), AFTER);
    // The hub replays the two broadcasts on the new connection (a re-delivery is not new state).
    const writeAgain = applyFrame(after, { v: 1, type: 'chapter:applied', seq: 2, ts: NOW, data: WRITE } as never);
    expect(writeAgain.state).toBe(after);
    const stageAgain = applyFrame(after, {
      v: 1,
      type: 'pass:stage',
      seq: 3,
      ts: NOW,
      data: {
        passId: 'stp_1',
        chapter: 3,
        stageSeq: 4,
        stage: 'verdict',
        at: T + 4 * MINUTE,
        actor: { process: 'engine', model: null },
        changeId: 'chg_2',
        summary: '',
        span: null,
        tokens: null,
        costUsd: null,
        attempt: 1,
        maxAttempts: 5,
        deadlineAt: T + 34 * MINUTE,
      },
    } as never);
    expect(stageAgain.state).toBe(after);
    // No effect either: a duplicate is not a reason to refetch or to print again.
    expect(writeAgain.effects).toEqual([]);
    expect(stageAgain.effects).toEqual([]);
  });

  it('applies the frames after the hello: the delivery cursor restarts at the new connection', () => {
    resetSeq();
    // `hello` opens a new session, so its own `seq` restarts at 1 even though the dead
    // connection had reached 9 (BOOK-220 B1). The frame after it is 2, not 10.
    const reopened = open(applyFrame(open(start(), BEFORE), { v: 1, type: 'chapter:applied', seq: 9, ts: NOW, data: WRITE } as never).state, AFTER);
    const closed = applyFrame(reopened, {
      v: 1,
      type: 'pass:closed',
      seq: 2,
      ts: NOW,
      data: { stepId: 'stp_1', changeId: 'chg_2', chapter: 3, pass: 'change', outcome: 'applied', sentence: 'правка внесена', at: T + 6 * MINUTE, closeFailed: false, costUsd: null, tokens: null },
    } as never);
    expect(closed.state).not.toBe(reopened);
    expect(closed.state.passes['stp_1']?.outcome).toBe('applied');
    expect(closed.effects.some((effect) => effect.kind === 'resync')).toBe(false);
  });

  it('does not re-apply a write the page had already printed before the drop', () => {
    resetSeq();
    // The page saw this write itself, then lost the socket; the new hello carries it again.
    const seen = applyFrame(open(start(), BEFORE), { v: 1, type: 'chapter:applied', seq: 9, ts: NOW, data: WRITE } as never).state;
    const reopened = open(seen, AFTER);
    expect(reopened.applied?.appliedAt).toBe(WRITE.appliedAt);
    // The same moment, not a second one: the print's clock reads the write once.
    expect(reopened.applied?.rev).toBe(WRITE.rev);
    expect(AT).toBeLessThan(WRITE.appliedAt);
  });
});
