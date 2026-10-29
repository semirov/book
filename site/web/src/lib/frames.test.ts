import type { HelloPayload, StateUpdatedPayload } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from './composer.ts';
import {
  applyFrame,
  initialClientState,
  laneOf,
  openPassesOf,
  passesOf,
  stagesFromLive,
  workingChapters,
} from './frames.ts';
import {
  AT,
  LIVE,
  NOW,
  STATE,
  applied,
  apply,
  catalog,
  chapterRevision,
  decided,
  filing,
  frame,
  passClosed,
  start,
} from './framesFixtures.ts';

/**
 * BOOK-DOC-84 §2.1/§3.2 — one case per frame, and the client's state after it is the server's
 * DTO for that domain.
 *
 * The reducer is pure, so every assertion is the wire payload and the state it produced: a
 * revision's `rev`, a write's `appliedAt`, a queue place's `ahead`, a filing's `attemptsLeft`,
 * a stage's `stageSeq`, a pass's outcome. A duplicate frame is asserted to be the *same state
 * object*: the apply cursors make a re-delivery cost nothing.
 */

describe('hello and the snapshot', () => {
  it('seeds the stage log from live.passes instead of emptying it', () => {
    const hello: HelloPayload = {
      connId: 'c1',
      protocolVersion: 4,
      serverTime: NOW,
      limits: { commentsPerHour: 5, maxCommentChars: 1_200, maxEditChars: 800, queueSoftCap: 50, maxConnections: 500, perIp: 8, editSubmissionsPerDay: 3, maxWave: 2 },
      viewer: { signedIn: false, displayName: null },
      composer: EMPTY_COMPOSER,
      front: { title: 'Бланк', about: null, rev: 1, imprint: { author: 'А', copyright: '© А' }, authors: { count: 1, measuredAt: NOW } },
      catalog,
      state: STATE,
      live: LIVE,
      currentChapter: null,
      comments: { open: 0 },
    };
    const { state } = apply(start(), 'hello', hello);
    expect(state.stages[3]).toHaveLength(1);
    expect(state.stages[3]?.[0]?.stage).toBe('drafting');
    expect(state.stages[3]?.[0]?.stageSeq).toBe(3);
    expect(state.queue).toEqual(LIVE.queue.pending);
    expect(state.filings).toEqual(LIVE.filings);
    expect(state.live?.lane.passesToday).toBe(2);
    expect(state.viewer.signedIn).toBe(false);
    expect(openPassesOf(state)).toHaveLength(1);
  });

  it('replaces the book and the live block from state:snapshot, healing every domain', () => {
    const snapshot = { state: { ...STATE, version: 9, queue: { ...STATE.queue, depth: 0, pending: [] } }, live: { ...LIVE, passes: [], queue: { ...LIVE.queue, pending: [] } } };
    const { state } = apply(start(), 'state:snapshot', snapshot);
    expect(state.book?.state.version).toBe(9);
    expect(state.queue).toEqual([]);
    expect(state.stages).toEqual({});
    expect(state.cursors.stateVersion).toBe(9);
  });
});

describe('the chapter domain', () => {
  it('applies a revision by rev and its hseq, and a duplicate changes nothing', () => {
    const first = apply(start(), 'chapter:revision', chapterRevision);
    expect(first.state.revisions[3]?.rev).toBe(2);
    expect(first.state.book?.catalog.find((row) => row.n === 3)?.rev).toBe(2);
    expect(first.state.cursors.hseq).toBe(7);
    const again = applyFrame(first.state, frame('chapter:revision', chapterRevision) as never);
    expect(again.state).toBe(first.state);
  });

  it('carries the write’s own clock: appliedAt, the patch and the span', () => {
    const { state } = apply(start(), 'chapter:applied', applied);
    expect(state.applied?.appliedAt).toBe(AT);
    expect(state.applied?.n).toBe(3);
    expect(state.applied?.rev).toBe(2);
    expect(state.cursors.hseq).toBe(7);
    // The article patches its blocks from the same revision the frame carries.
    expect(state.revisions[3]?.patch).toEqual(chapterRevision.patch);
    const again = applyFrame(state, frame('chapter:applied', applied) as never);
    expect(again.state).toBe(state);
  });

  it('adds a created chapter to the catalog, and never lowers a rev', () => {
    const created = {
      n: 4,
      title: 'Четвёртая',
      rev: 1,
      chars: 40,
      part: 1,
      direction: 'forward',
      cause: { kind: 'draft', lane: 'forward', leaseId: null, changeId: null, cascadeId: null, stepId: null },
      fetch: { path: '/api/chapters/4', etag: 'x' },
      createdAt: NOW,
      attributed: true,
    };
    const { state } = apply(start(), 'chapter:created', created);
    expect(state.book?.catalog.find((row) => row.n === 4)?.written).toBe(true);
    expect(state.fresh).toBe(4);
  });

  it('moves the front and its title motion', () => {
    const { state } = apply(start(), 'front:updated', { title: 'Бланк II', about: null, rev: 2, previousRev: 1, cause: { kind: 'edit', changeId: null, cascadeId: null, stepId: null } });
    expect(state.book?.front.rev).toBe(2);
    expect(state.titleMotion.token).toBeGreaterThan(0);
  });
});

describe('the change domain', () => {
  it('consumes change:queued’s place instead of refetching', () => {
    const { state, effects } = apply(start(), 'change:queued', {
      id: 'chg_2', seq: 2, kind: 'edit', chapter: 4, intent: 'x',
      source: { commentId: 'cmt_1', author: 'Аня' }, queue: { depth: 3, ahead: 2 },
      base: { rev: 1 }, scopeHint: 'phrase', at: AT, eventSeq: 5,
    });
    expect(state.lines.chg_2).toMatchObject({ kind: 'queued', ahead: 2, depth: 3 });
    expect(state.cursors.eventSeq).toBe(5);
    expect(effects.filter((effect) => effect.kind === 'refreshChanges')).toHaveLength(0);
    const again = applyFrame(state, frame('change:queued', { id: 'chg_2', seq: 2, kind: 'edit', chapter: 4, intent: 'x', source: { commentId: null, author: null }, queue: { depth: 3, ahead: 2 }, base: { rev: 1 }, scopeHint: 'phrase', at: AT, eventSeq: 5 }) as never);
    expect(again.state).toBe(state);
  });

  it('records the claim’s place and attempt from change:processing', () => {
    const { state } = apply(start(), 'change:processing', {
      id: 'chg_2', chapter: 4, startedAt: NOW, attempt: 2, relevance: null, queue: { ahead: 1 }, at: AT, eventSeq: 6,
    });
    expect(state.lines.chg_2).toMatchObject({ kind: 'processing', ahead: 1, attempt: 2 });
    expect(state.book?.state.queue.processing?.id).toBe('chg_2');
  });

  it('renders the narrowed intent and the stale line from their payloads', () => {
    const adapted = apply(start(), 'change:adapted', { id: 'chg_2', chapter: 4, intent: 'узкий смысл', reason: 'не про эту сцену', at: AT, eventSeq: 7 });
    expect(adapted.state.lines.chg_2).toMatchObject({ kind: 'adapted', intent: 'узкий смысл' });
    const stale = apply(start(), 'change:stale', { id: 'chg_2', grade: 'weak', evidence: ['e'], options: ['adapt'], survivesAs: null, at: AT, eventSeq: 8 });
    expect(stale.state.lines.chg_2).toMatchObject({ kind: 'stale', grade: 'weak' });
  });

  it('resolves the decided line and asks the record and the follow to move', () => {
    const { state, effects } = apply(start(), 'change:decided', decided);
    expect(state.lines.chg_2).toMatchObject({ kind: 'decided' });
    expect(effects.map((effect) => effect.kind)).toContain('landFrame');
    expect(effects.map((effect) => effect.kind)).toContain('noteRecord');
  });
});

describe('the pass domain', () => {
  it('opens a pass on its claim and closes it on its outcome', () => {
    const accepted = apply(start(), 'pass:accepted', {
      stepId: 'stp_9', chapter: 5, lane: 'forward', pass: 'draft', premiseChangeId: null, at: AT, ahead: 0,
    });
    expect(accepted.state.accepted.stp_9?.chapter).toBe(5);
    expect(openPassesOf(accepted.state).some((pass) => pass.passId === 'stp_9')).toBe(true);

    const closed = apply(accepted.state, 'pass:closed', passClosed);
    expect(closed.state.passes.stp_1?.outcome).toBe('refused');
    // `hello`'s own open pass is the one the close names, so the head has nothing left to say.
    expect(openPassesOf(closed.state).some((pass) => pass.passId === 'stp_1')).toBe(false);
  });

  it('appends a stage by (passId, stageSeq) and ignores a re-delivery', () => {
    const event = { passId: 'stp_1', chapter: 3, stageSeq: 4, stage: 'verdict', at: AT + 1_000, actor: { process: 'writer', model: null }, changeId: null, summary: '', span: null, tokens: null, costUsd: null };
    const first = apply(start(), 'pass:stage', event);
    expect(first.state.stages[3]?.at(-1)?.stage).toBe('verdict');
    expect(first.state.cursors.stage.stp_1).toBe(4);
    const again = applyFrame(first.state, frame('pass:stage', event) as never);
    expect(again.state).toBe(first.state);
  });
});

describe('filings and the thread', () => {
  it('moves a filing’s row and its tries left in place', () => {
    const seeded = apply(start(), 'hello', {
      connId: 'c1', protocolVersion: 4, serverTime: NOW,
      limits: { commentsPerHour: 5, maxCommentChars: 1_200, maxEditChars: 800, queueSoftCap: 50, maxConnections: 500, perIp: 8, editSubmissionsPerDay: 3, maxWave: 2 },
      viewer: { signedIn: true, displayName: 'Аня' }, composer: EMPTY_COMPOSER,
      front: { title: 'Бланк', about: null, rev: 1, imprint: { author: 'А', copyright: '© А' }, authors: { count: 1, measuredAt: NOW } },
      catalog, state: STATE, live: LIVE, currentChapter: null, comments: { open: 0 },
    } as HelloPayload).state;
    const { state } = apply(seeded, 'filing:update', filing);
    const row = state.filings.find((item) => item.commentId === 'cmt_1');
    expect(row?.state).toBe('refused');
    expect(row?.attemptsLeft).toBe(1);
    expect(state.filingUpdates.cmt_1?.attempts).toBe(2);
    expect(state.cursors.filing.cmt_1).toBe(AT);
    const again = applyFrame(state, frame('filing:update', filing) as never);
    expect(again.state).toBe(state);
  });

  it('inserts a comment’s DTO without a refetch, once', () => {
    const dto = {
      id: 'cmt_9', chapter: 4,
      anchor: { blockId: 'ch04#a', quote: 'цитата', resolved: true, offset: 0 },
      author: 'Аня', authorColor: 'red', body: 'тело', proposedText: null, interventionKind: null,
      status: 'new', refusal: null, frame: null, premise: false, reason: null, attempt: null,
      createdAt: NOW, decidedAt: null, changeId: null, applied: null,
    };
    const { state, effects } = apply(start(), 'comment:added', {
      id: 'cmt_9', chapter: 4, anchor: dto.anchor, author: 'Аня', authorColor: 'red', body: 'тело',
      interventionKind: null, status: 'new', reason: null, createdAt: NOW, comment: dto,
    });
    expect(state.added.map((row) => row.id)).toEqual(['cmt_9']);
    expect(effects.filter((effect) => effect.kind === 'refreshComments')).toHaveLength(0);
    const again = applyFrame(state, frame('comment:added', { id: 'cmt_9', chapter: 4, anchor: dto.anchor, author: 'Аня', authorColor: 'red', body: 'тело', interventionKind: null, status: 'new', reason: null, createdAt: NOW, comment: dto }) as never);
    expect(again.state).toBe(state);
  });

  it('carries attemptsLeft from a decision and keeps the record’s reload', () => {
    const { state, effects } = apply(start(), 'comment:decision', {
      id: 'cmt_1', chapter: 4, status: 'accepted', reason: '', decidedAt: NOW, batchId: null,
      changeId: 'chg_2', queue: { depth: 1, ahead: 0 }, source: 'llm', attemptsLeft: 2, at: AT,
    });
    expect(state.attemptsLeft.cmt_1).toBe(2);
    expect(effects.some((effect) => effect.kind === 'refreshComments')).toBe(true);
  });
});

describe('the transport and the engine', () => {
  it('keeps the engine’s line and prints an error as «связь: code»', () => {
    const engine = apply(start(), 'engine:state', {
      status: 'paused', since: NOW, reason: 'owner', queue: { depth: 1 }, passesToday: 3, maxPasses: 4, writerAt: NOW,
    });
    expect(engine.state.engine?.status).toBe('paused');
    expect(engine.state.engine?.passesToday).toBe(3);
    const error = apply(start(), 'error', { code: 'RATE_LIMITED', message: 'slow down' });
    expect(error.state.connection).toBe('RATE_LIMITED');
  });

  it('ticks the record on a history event and has no surface on pong', () => {
    const tick = apply(start(), 'history:event', { hseq: 11, at: NOW });
    expect(tick.state.historyTick).toBe(1);
    const pong = apply(start(), 'pong', { t: 1, serverTime: NOW });
    expect(pong.state).toMatchObject({ historyTick: 0, connection: null });
  });

  it('asks for one snapshot on a delivery gap, and applies the frame it did get', () => {
    const state = { ...start(), seq: 5 };
    const result = applyFrame(state, { v: 1, type: 'history:event', seq: 8, ts: NOW, data: { hseq: 12, at: NOW } } as never);
    expect(result.effects).toContainEqual({ kind: 'resync', since: 5 });
    expect(result.state.historyTick).toBe(1);
  });

  it('ignores a frame the client already applied (its seq is not newer)', () => {
    const state = { ...start(), seq: 5 };
    const result = applyFrame(state, { v: 1, type: 'error', seq: 5, ts: NOW, data: { code: 'X' } } as never);
    expect(result.state).toBe(state);
  });
});

describe('state:updated', () => {
  it('replaces the snapshot and the queue’s waiting list', () => {
    const snapshot: StateUpdatedPayload = {
      ...STATE,
      version: 4,
      reason: 'engine',
      queue: { ...STATE.queue, depth: 1, pending: LIVE.queue.pending },
    };
    const { state } = apply(start(), 'state:updated', snapshot);
    expect(state.book?.state.version).toBe(4);
    expect(state.queue).toEqual(LIVE.queue.pending);
    expect(state.cursors.stateVersion).toBe(4);
  });
});

describe('a stage cursor is per pass', () => {
  it('does not stop one pass because another already reached that seq', () => {
    const one = { passId: 'stp_1', chapter: 3, stageSeq: 9, stage: 'verdict', at: AT, actor: { process: 'writer', model: null }, changeId: null, summary: '', span: null, tokens: null, costUsd: null };
    const two = { ...one, passId: 'stp_2', chapter: 4, stageSeq: 1 };
    const first = apply(start(), 'pass:stage', one);
    const second = apply(first.state, 'pass:stage', two);
    expect(second.state.stages[4]).toHaveLength(1);
    expect(second.state.cursors.stage.stp_2).toBe(1);
  });
});

describe('the remaining carriers', () => {
  it('heals the byline from authors:update and leaves a bare page alone', () => {
    const { state } = apply(start(), 'authors:update', { count: 7, measuredAt: '2026-10-29T13:00:00Z' });
    expect(state.book?.front.authors.count).toBe(7);
    // A frame before the catalogue arrived is not a crash: the book stays null.
    const bare = applyFrame(initialClientState(), frame('authors:update', { count: 7, measuredAt: NOW }) as never);
    expect(bare.state.book).toBeNull();
  });

  it('moves the ribbon on cascade:progress and has no surface on pong', () => {
    const { state } = apply(start(), 'cascade:progress', {
      cascadeId: 'cas_1', changeId: 'chg_1', origin: 3, wave: 1, lane: 'forward', chapter: 4,
      boundary: 3, phase: 'rewrite', outcome: null, rev: { before: 1, after: 2 },
      frontier: { forward: 4, backward: null }, wings: { forward: [], backward: [] },
      touched: [3, 4], rewritten: [3], seamsIn: [], seamsOut: [],
      budget: { steps: 1, maxSteps: 8, msLeft: 10_000 },
    });
    expect(state.ribbon).not.toBeNull();
    expect(state.historyTick).toBe(0);
  });

  it('adds a filing the page had never read, then patches it in place', () => {
    const fresh = apply(start(), 'filing:update', filing);
    expect(fresh.state.filings.map((row) => row.commentId)).toEqual(['cmt_1']);
    const patched = apply(fresh.state, 'filing:update', { ...filing, state: 'accepted', at: AT + 5_000, attemptsLeft: 0 });
    expect(patched.state.filings[0]?.state).toBe('accepted');
    expect(patched.state.filings[0]?.attemptsLeft).toBe(0);
  });

  it('falls back to the register’s read when an older server sends no DTO', () => {
    const { effects } = apply(start(), 'comment:added', { id: 'cmt_9', chapter: 4 });
    expect(effects).toContainEqual({ kind: 'refreshComments', chapter: 4 });
  });

  it('re-reads the register on a feedback batch', () => {
    const { effects } = apply(start(), 'feedback:batch', { batchId: 'b', count: 2, chapter: 4, createdAt: NOW });
    expect(effects).toContainEqual({ kind: 'refreshComments' });
  });

  it('survives a snapshot before any book is held', () => {
    const { state } = applyFrame(initialClientState(), frame('state:snapshot', { state: STATE, live: LIVE }) as never);
    expect(state.book).toBeNull();
    expect(state.queue).toEqual(LIVE.queue.pending);
  });
});

describe('the live block’s own fold', () => {
  it('names the chapters a pass works on and the stage log’s pass map', () => {
    const seeded = apply(start(), 'state:snapshot', { state: STATE, live: LIVE }).state;
    const accepted = apply(seeded, 'pass:accepted', {
      stepId: 'stp_2', chapter: 6, lane: 'forward', pass: 'change', premiseChangeId: null, at: AT, ahead: 1,
    }).state;
    expect([...workingChapters(accepted)].sort()).toEqual([3, 6]);
    expect(Object.keys(passesOf(accepted))).toEqual(['3']);
    expect(stagesFromLive(LIVE.passes)[3]).toHaveLength(1);
  });

  it('reads the lane from the live block, else from the snapshot', () => {
    expect(laneOf(start())).toBeNull();
    const hello = apply(start(), 'hello', {
      connId: 'c1', protocolVersion: 4, serverTime: NOW,
      limits: { commentsPerHour: 5, maxCommentChars: 1_200, maxEditChars: 800, queueSoftCap: 50, maxConnections: 500, perIp: 8, editSubmissionsPerDay: 3, maxWave: 2 },
      viewer: { signedIn: false, displayName: null }, composer: EMPTY_COMPOSER,
      front: { title: 'Бланк', about: null, rev: 1, imprint: { author: 'А', copyright: '© А' }, authors: { count: 1, measuredAt: NOW } },
      catalog, state: STATE, live: LIVE, currentChapter: null, comments: { open: 0 },
    } as HelloPayload);
    expect(laneOf(hello.state)?.maxPasses).toBe(4);
  });
});

describe('frames before the catalogue arrives', () => {
  it('never invents a book: the domain facts land, the page waits for its REST read', () => {
    let state = initialClientState();
    const frames: Array<[string, unknown]> = [
      ['chapter:applied', applied],
      ['front:updated', { title: 'Бланк II', about: null, rev: 2, previousRev: 1, cause: { kind: 'edit', changeId: null, cascadeId: null, stepId: null } }],
      ['chapter:created', {
        n: 4, title: 'Четвёртая', rev: 1, chars: 40, part: 1, direction: 'forward',
        cause: { kind: 'draft', lane: 'forward', leaseId: null, changeId: null, cascadeId: null, stepId: null },
        fetch: { path: '/api/chapters/4', etag: 'x' }, createdAt: NOW, attributed: true,
      }],
      ['change:processing', { id: 'chg_2', chapter: 4, startedAt: NOW, attempt: 1, relevance: null, queue: { ahead: 0 }, at: AT, eventSeq: 9 }],
    ];
    for (const [type, data] of frames) state = apply(state, type, data).state;
    expect(state.book).toBeNull();
    expect(state.revisions[3]?.rev).toBe(2);
    expect(state.applied?.n).toBe(3);
  });
});
