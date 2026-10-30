/**
 * BOOK-235 — the claim path: why a claim got nothing, and what it does about it.
 *
 * `claimFiling` used to answer `null` for two unrelated situations — a lane that is genuinely
 * busy, and a queue wedged by a row no rule moves — and the writer printed «idle: пока нечего
 * писать: заявок нет» for both. These tests pin the answers: the guard is named in one line, the
 * row that **owns** the block is healed (never the innocent head), only the head's own row is
 * counted against the queue's bound, a premise the draft lane cannot serve never starves the lane
 * behind it, and a genuinely held lane still hands out nothing and counts nothing.
 */

import { QUEUE_MAX_ATTEMPTS, droppedLine, type WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { PREMISE_STALE_REASON } from '../../src/engine/premise.ts';
import { createQueue } from '../../src/engine/queue.ts';
import { queueBlockOf } from '../../src/engine/queueBlock.ts';
import * as store from '../../src/engine/store.ts';
import { sweepZombies } from '../../src/engine/zombieSweep.ts';
import { toIso } from '../../src/util/time.ts';
import { createEngineFixture } from './helpers.ts';
import { addChange, addComment, addOpenStep, book } from './zombieHelpers.ts';

describe('the claim path (BOOK-235)', () => {
  it('names the block in the writer’s log, heals it, and never counts a held lane', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      // A head whose open step `claimOpenStep` can never hand out (the ending is not rewritten by
      // a ripple), so the claim really reaches `claimHead` and its open-step guard.
      const head = addChange(fixture, { id: 'chg_head', chapter: 1 });
      addOpenStep(fixture, { id: 'stp_ending', chapter: 42, changeId: head, pass: 'cascade' });

      const healed = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;
      expect(healed.changeId).toBe(head);
      expect(lines[0]).toMatch(/^queue: change chg_head cannot be claimed — open_step \(stp_ending\)$/u);
      // The sweep's own line follows in the same poll: the operator sees what was healed.
      expect(lines).toContain('zombie sweep: step stp_ending (open step, no lease 2 min) -> interrupted · open-step-unclaimable');
      expect(store.getStep(fixture.db, 'stp_ending')?.outcome).toBe('interrupted');

      // A lane genuinely held by another change is nobody's attempt: one line, no count, no job.
      const fixture2 = createEngineFixture({ filings: 'manual' });
      const second: string[] = [];
      try {
        book(fixture2);
        fixture2.deps.log = (line) => second.push(line);
        const first = addChange(fixture2, { id: 'chg_first', chapter: 1 });
        const blocked = addChange(fixture2, { id: 'chg_second', chapter: 2 });
        expect((fixture2.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment).changeId).toBe(first);
        second.length = 0;

        expect(fixture2.engine.next({ for: 'filing', session: 's2' })).toBeNull();
        expect(second).toEqual([`queue: change ${blocked} cannot be claimed — lane_held (${first} · processing)`]);
        expect(store.getChange(fixture2.db, blocked)?.attempts).toBe(0);
        // One line per poll, not one per session: the same block says the same sentence once.
        expect(fixture2.engine.next({ for: 'filing', session: 's3' })).toBeNull();
        expect(second).toHaveLength(1);
      } finally {
        fixture2.close();
      }
    } finally {
      fixture.close();
    }
  });

  it('opens the premise branch: names the written-chapter premise, settles it, and claims the change behind it', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      // The prod shape: a premise filed on a chapter that already has text (a written chapter
      // changes through the lane, so no first pass will ever consume it) and a change behind it.
      const premise = addChange(fixture, {
        id: 'chg_premise',
        chapter: 2,
        premise: 1,
        commentId: addComment(fixture, 'cmt_p', 2),
      });
      const behind = addChange(fixture, { id: 'chg_behind', chapter: 1 });

      const assignment = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;

      // The poll says why no draft was opened, and whose row it settled — then claims the change.
      expect(lines).toContain(`queue: filing ${premise} (chapter 2) cannot be opened — chapter-written`);
      expect(lines).toContain(`queue: filing ${premise} settled — premise-stale`);
      expect(store.getChange(fixture.db, premise)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: PREMISE_STALE_REASON,
      });
      expect(assignment).not.toBeNull();
      expect(assignment.changeId).toBe(behind);
      expect(store.readLane(fixture.db).holder).toBe(behind);
    } finally {
      fixture.close();
    }
  });

  it('names a premise it cannot open for want of capacity, counts nothing in the lane and hands nothing out', () => {
    const fixture = createEngineFixture({ filings: 'manual', env: { ENGINE_MAX_CONCURRENT_PROCESSES: '1' } });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      // The one process slot is taken by a pass somebody is running.
      const busy = addOpenStep(fixture, { id: 'stp_busy', chapter: 1, changeId: null });
      const now = fixture.clock.now();
      store.insertLease(fixture.db, {
        id: 'lea_busy',
        stepId: busy,
        changeId: null,
        cascadeId: null,
        lane: null,
        chapter: 1,
        isFront: 0,
        kind: 'draft',
        session: 'other-pass',
        expectedRev: 0,
        acquiredAt: toIso(now),
        heartbeatAt: toIso(now),
        expiresAt: toIso(now + fixture.config.leaseTtlMs),
      });
      const premise = addChange(fixture, { id: 'chg_waiting', chapter: 5, premise: 1 });

      expect(fixture.engine.next({ for: 'filing', session: 's1' })).toBeNull();
      expect(lines).toContain(`queue: filing ${premise} (chapter 5) cannot be opened — no-capacity`);
      // Nothing was handed out and no lane was taken; the premise is still waiting its turn.
      expect(store.readLane(fixture.db).holder).toBeNull();
      expect(store.getChange(fixture.db, premise)?.status).toBe('pending');
    } finally {
      fixture.close();
    }
  });

  it('heals the change that owns the block, never the head — ghost and cascade alike', () => {
    // A foreign `processing` ghost: the head is innocent and must spend no attempt.
    const fixture = createEngineFixture({ filings: 'manual' });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      // The head comes first in the queue; the ghost is another change's dead claim.
      const head = addChange(fixture, { id: 'chg_head', chapter: 1 });
      const ghost = addChange(fixture, { id: 'chg_ghost', chapter: 2, status: 'processing' });

      const claimed = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;

      expect(lines[0]).toBe(`queue: change ${head} cannot be claimed — processing_ghost (${ghost})`);
      // The sweep was narrowed to the ghost's own row — and only that row changed.
      expect(lines).toContain(
        `zombie sweep: change ${ghost} (processing · attempts 0) -> pending (retry 1 of ${String(QUEUE_MAX_ATTEMPTS)}) · processing-ghost`,
      );
      expect(store.getChange(fixture.db, ghost)?.status).toBe('pending');
      expect(claimed.changeId).toBe(head);
      expect(store.getChange(fixture.db, head)?.attempts).toBe(0);
    } finally {
      fixture.close();
    }

    // A foreign open cascade: same rule, the cascade's change is the owner.
    const second = createEngineFixture({ filings: 'manual' });
    const secondLines: string[] = [];
    try {
      book(second);
      second.deps.log = (line) => secondLines.push(line);
      const head = addChange(second, { id: 'chg_head', chapter: 1 });
      const orphan = addChange(second, {
        id: 'chg_orphan',
        chapter: 2,
        status: 'void',
        outcome: 'dropped',
        reason: droppedLine('superseded'),
      });
      store.insertCascade(second.db, {
        id: 'csc_orphan',
        changeId: orphan,
        budget: '{}',
        openedAt: toIso(second.clock.now()),
      });

      const claimed = second.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;

      expect(secondLines[0]).toBe(`queue: change ${head} cannot be claimed — open_cascade (csc_orphan)`);
      expect(secondLines).toContain('zombie sweep: cascade csc_orphan (open cascade) -> aborted · cascade-orphan');
      expect(store.getCascade(second.db, 'csc_orphan')).toMatchObject({ status: 'aborted' });
      expect(claimed.changeId).toBe(head);
      expect(store.getChange(second.db, head)?.attempts).toBe(0);
    } finally {
      second.close();
    }
  });

  it('spends one attempt, not the queue’s, when the engine refuses on capacity', () => {
    const fixture = createEngineFixture({ filings: 'manual', env: { ENGINE_MAX_CONCURRENT_PROCESSES: '1' } });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      // The one process slot is saturated by a draft somebody is running …
      const busy = addOpenStep(fixture, { id: 'stp_busy', chapter: 1, changeId: null });
      const now = fixture.clock.now();
      store.insertLease(fixture.db, {
        id: 'lea_busy',
        stepId: busy,
        changeId: null,
        cascadeId: null,
        lane: null,
        chapter: 1,
        isFront: 0,
        kind: 'draft',
        session: 'other-pass',
        expectedRev: 0,
        acquiredAt: toIso(now),
        heartbeatAt: toIso(now),
        expiresAt: toIso(now + fixture.config.leaseTtlMs),
      });
      // … and three filings wait behind it.
      const first = addChange(fixture, { id: 'chg_one', chapter: 1 });
      const second = addChange(fixture, { id: 'chg_two', chapter: 2 });
      const third = addChange(fixture, { id: 'chg_three', chapter: 3 });

      expect(fixture.engine.next({ for: 'filing', session: 's1' })).toBeNull();
      // One fact for the whole poll, said once and named honestly: the caps, not a lost mutex.
      expect(lines).toEqual([`queue: change ${first} cannot be claimed — capacity`]);
      // The head spent its one attempt (a claim the engine reached and refused); nobody else did,
      // and no filing was lost to a machine that could not take any of them.
      expect(store.getChange(fixture.db, first)?.attempts).toBe(1);
      expect(store.getChange(fixture.db, second)?.attempts).toBe(0);
      expect(store.getChange(fixture.db, third)?.attempts).toBe(0);
      for (const id of [first, second, third]) {
        expect(store.getChange(fixture.db, id)?.status).not.toBe('void');
      }
      // Only the head's own rolled-back step is on disk: the walk never started.
      const interrupted = fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM steps WHERE outcome = 'interrupted'`)
        .get() as { n: number };
      expect(interrupted.n).toBe(1);

      // The next poll is the same poll: one more attempt for the head, still nothing for the rest.
      expect(fixture.engine.next({ for: 'filing', session: 's2' })).toBeNull();
      expect(store.getChange(fixture.db, first)?.attempts).toBe(2);
      expect(store.getChange(fixture.db, second)?.attempts).toBe(0);
      expect(store.getChange(fixture.db, third)?.attempts).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('closes a stranded claimable step of the head, not only an unclaimable one', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      // The head's own open step, no lease: `claimOpenStep` would hand it out again, and
      // `claimHead` can never pass its `stepsOfChange(head)` guard while it stands.
      const head = addChange(fixture, { id: 'chg_head', chapter: 1 });
      addOpenStep(fixture, { id: 'stp_stranded', chapter: 1, changeId: head });

      const report = sweepZombies(fixture.deps);

      expect(report.rows).toEqual([
        {
          kind: 'step',
          id: 'stp_stranded',
          changeId: head,
          condition: 'open-step-blocks-head',
          was: 'open step, no lease 2 min',
          became: 'interrupted',
        },
      ]);
      // The lane then takes the head, as the boot sweep promises.
      const assignment = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;
      expect(assignment.changeId).toBe(head);
    } finally {
      fixture.close();
    }
  });

  it('names a paused day in the premise branch, counts nothing and hands nothing out', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      // 10.01 $ of the day's 10 $, written as the ledger's own row: the pause `budget.ts` decides.
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
           VALUES ('2026-10-25T09:00:00Z', '2026-10-25', 'stp_spend', NULL, 'draft', NULL, 'model', 0, 0, 10.01, 1)`,
        )
        .run();
      const premise = addChange(fixture, { id: 'chg_paused', chapter: 5, premise: 1 });

      // `next` refuses at its own first budget guard, before the branch is reached; the branch is
      // the last defence, so it is asked directly — the same call `claimFiling` makes.
      const queue = createQueue(fixture.deps);
      expect(queue.claimFiling('s1')).toBeNull();

      expect(lines).toContain(`queue: filing ${premise} (chapter 5) cannot be opened — budget-paused`);
      expect(store.getChange(fixture.db, premise)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(store.readLane(fixture.db).holder).toBeNull();
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('names a live pass, and falls through to the next change when the head’s own step cannot be healed', () => {
    // A pass in flight: `processing` with a live lease and no lane holder to name it.
    const live = createEngineFixture({ filings: 'manual' });
    const liveLines: string[] = [];
    try {
      book(live);
      live.deps.log = (line) => liveLines.push(line);
      const running = addChange(live, { id: 'chg_running', chapter: 1, status: 'processing' });
      const step = addOpenStep(live, { id: 'stp_running', chapter: 1, changeId: running });
      const now = live.clock.now();
      store.insertLease(live.db, {
        id: 'lea_running',
        stepId: step,
        changeId: running,
        cascadeId: null,
        lane: null,
        chapter: 1,
        isFront: 0,
        kind: 'change',
        session: 'pass-1',
        expectedRev: 0,
        acquiredAt: toIso(now),
        heartbeatAt: toIso(now),
        expiresAt: toIso(now + live.config.leaseTtlMs),
      });
      const head = addChange(live, { id: 'chg_waiting', chapter: 2 });

      expect(live.engine.next({ for: 'filing', session: 's2' })).toBeNull();
      expect(liveLines).toContain(`queue: change ${head} cannot be claimed — processing_live (${running})`);
      expect(store.getChange(live.db, head)?.attempts).toBe(0);
    } finally {
      live.close();
    }

    // A wedged head the sweep cannot heal: the lane's own counter moves, and the queue behind it
    // is still served — the fairness the fall-through exists for.
    const fixture = createEngineFixture({ filings: 'manual' });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      const blocked = addChange(fixture, { id: 'chg_blocked', chapter: 1 });
      // `claimOpenStep` can never hand this shape out (the ending is never rewritten by a ripple),
      // so the poll reaches `claimHead` and the head's own open step is the block.
      addOpenStep(fixture, { id: 'stp_blocked', chapter: 42, pass: 'cascade', changeId: blocked });
      fixture.db.exec(
        `CREATE TRIGGER test_refuse_step BEFORE UPDATE ON steps WHEN OLD.step_id = 'stp_blocked'
         BEGIN SELECT RAISE(ABORT, 'test: poisoned step'); END`,
      );
      const behind = addChange(fixture, { id: 'chg_behind', chapter: 2 });

      const assignment = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;

      expect(lines).toContain(`zombie sweep: failed stp_blocked (UNKNOWN)`);
      // The block is said once, however many times the poll reports: the heal failed, the block
      // was recomputed, and the operator still reads one sentence about one fact.
      const blockLineSaid = lines.filter(
        (line) => line === `queue: change ${blocked} cannot be claimed — open_step (stp_blocked)`,
      );
      expect(blockLineSaid).toHaveLength(1);
      // The head's own step is its attempt (the queue's bound ends it after six) …
      expect(store.getChange(fixture.db, blocked)?.attempts).toBe(1);
      // … and the queue behind it is not starved by a row that cannot be healed.
      expect(assignment.changeId).toBe(behind);
      expect(store.readLane(fixture.db).holder).toBe(behind);
      expect(store.getStep(fixture.db, 'stp_blocked')?.outcome).toBeNull();
    } finally {
      fixture.close();
    }

    // Every guard passing and the mutex not taken is `claim_lost`, not silence.
    const clean = createEngineFixture({ filings: 'manual' });
    try {
      book(clean);
      const only = addChange(clean, { id: 'chg_only', chapter: 1 });
      const row = store.getChange(clean.db, only) as store.ChangeRow;
      expect(queueBlockOf(clean.deps, row)).toMatchObject({ condition: 'claim_lost', reached: true, ownerId: null });
    } finally {
      clean.close();
    }
  });
});
