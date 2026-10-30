/**
 * BOOK-235 — the zombie sweep.
 *
 * The owner's hole: a filing was made, the site created a change in `pending`, and the writer
 * answered «idle: пока нечего писать» for ever. Behind it sat rows no rule moves any more —
 * legacy `escalated` changes, an open step nobody can be handed, an open cascade under a change
 * that will never be `processing` again — and every guard in `claimHead` read them as work in
 * flight. These tests fabricate exactly those rows (`zombieHelpers.ts`, the way `wall.test.ts`
 * does) and prove the sweep ends them, tells no reader a lie while doing it, and never touches a
 * row that is genuinely held.
 *
 * The claim path's own answers — the block it names, the premise branch, the fall-through — are
 * `zombieSweepClaim.test.ts`.
 */

import { QUEUE_MAX_ATTEMPTS, droppedLine, queueAttemptsLine, type WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import * as store from '../../src/engine/store.ts';
import { ZOMBIE_GRACE_MS, sweepZombies } from '../../src/engine/zombieSweep.ts';
import { toIso } from '../../src/util/time.ts';
import { createEngineFixture } from './helpers.ts';
import { addChange, addComment, addDevice, addOpenStep, book, filingStateOf } from './zombieHelpers.ts';

describe('the zombie sweep (BOOK-235)', () => {
  it('ends the owner’s three escalated rows and lets the blocked filing be claimed', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      // Two filings whose text landed through a *later* change, and one whose chain is spent.
      const supersededA = addChange(fixture, {
        id: 'chg_01M66Q_a',
        chapter: 1,
        status: 'escalated',
        outcome: 'origin',
        commentId: addComment(fixture, 'cmt_a', 1),
      });
      addChange(fixture, {
        id: 'chg_sibling_a',
        chapter: 1,
        status: 'done',
        outcome: 'applied',
        commentId: 'cmt_a',
      });
      const supersededB = addChange(fixture, {
        id: 'chg_01M66Q_b',
        chapter: 2,
        status: 'escalated',
        outcome: 'gate_timeout',
        commentId: addComment(fixture, 'cmt_b', 2),
      });
      addChange(fixture, {
        id: 'chg_sibling_b',
        chapter: 2,
        status: 'done',
        outcome: 'applied',
        commentId: 'cmt_b',
      });
      const exhausted = addChange(fixture, {
        id: 'chg_01M66Q_c',
        chapter: 3,
        status: 'escalated',
        outcome: 'origin',
        attempts: QUEUE_MAX_ATTEMPTS - 1,
        commentId: addComment(fixture, 'cmt_c', 3),
      });
      // The filing the writer could not reach: its own open step made the head's guard permanent.
      const pending = addChange(fixture, {
        id: 'chg_pending',
        chapter: 3,
        commentId: addComment(fixture, 'cmt_d', 3),
      });
      addOpenStep(fixture, { id: 'stp_zombie', chapter: 3, changeId: pending });

      const report = sweepZombies(fixture.deps);

      // One row and exactly one line per acted row: the step and the three escalated changes.
      expect(report.failures).toEqual([]);
      expect(report.rows.map((row) => row.id)).toEqual(['stp_zombie', supersededA, supersededB, exhausted]);
      expect(report.lines).toHaveLength(4);
      expect(new Set(report.lines).size).toBe(4);
      expect(report.lines).toContain(
        `zombie sweep: step stp_zombie (open step, no lease 2 min) -> interrupted · open-step-blocks-head`,
      );
      expect(report.lines).toContain(
        `zombie sweep: change ${supersededA} (escalated · origin) -> void · dropped · escalated-superseded`,
      );
      expect(report.lines).toContain(
        `zombie sweep: change ${exhausted} (escalated · origin) -> void · dropped · escalated-exhausted`,
      );
      for (const id of [supersededA, supersededB, exhausted]) {
        expect(store.getChange(fixture.db, id)).toMatchObject({ status: 'void', outcome: 'dropped' });
      }
      // A blocked open step is interrupted, never closed as work: no cascade, no text, no candidate.
      expect(store.getStep(fixture.db, 'stp_zombie')).toMatchObject({ outcome: 'interrupted' });
      // The sweep writes the sentence a reader may print, and nothing of its own invention.
      expect(store.getChange(fixture.db, supersededA)?.reason).toBe(droppedLine('superseded'));

      // The claim now reaches the head of the queue in the same engine call.
      const assignment = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;
      expect(assignment).not.toBeNull();
      expect(assignment.changeId).toBe(pending);
      expect(store.getLease(fixture.db, assignment.leaseId)?.change_id).toBe(pending);
      expect(store.readLane(fixture.db).holder).toBe(pending);
      expect(store.getChange(fixture.db, pending)?.status).toBe('processing');

      // The exhausted filing is the reader's «не принято»; the two that landed keep their landing:
      // the sweep ends a zombie attempt, it never re-decides text the reader already has.
      expect(filingStateOf(fixture, 'cmt_c')).toBe('rejected');
      expect(filingStateOf(fixture, 'cmt_a')).toBe('applied');
      expect(filingStateOf(fixture, 'cmt_b')).toBe('applied');
    } finally {
      fixture.close();
    }
  });

  it('re-enters an escalated stop whose filing never landed, and counts the attempt', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      const stopped = addChange(fixture, {
        id: 'chg_stopped',
        chapter: 2,
        status: 'escalated',
        outcome: 'gate_timeout',
        attempts: 0,
        commentId: addComment(fixture, 'cmt_stop', 2),
      });

      const report = sweepZombies(fixture.deps);

      expect(report.rows).toEqual([
        {
          kind: 'change',
          id: stopped,
          changeId: stopped,
          condition: 'escalated-retry',
          was: 'escalated · gate_timeout',
          became: `pending (retry 1 of ${String(QUEUE_MAX_ATTEMPTS)})`,
        },
      ]);
      expect(store.getChange(fixture.db, stopped)).toMatchObject({
        status: 'pending',
        attempts: 1,
        outcome: null,
        reason: null,
        started_at: null,
        finished_at: null,
        cascade_id: null,
      });
      const released = fixture.db
        .prepare(`SELECT meta FROM change_events WHERE change_id = ? AND type = 'released'`)
        .all(stopped) as Array<{ meta: string }>;
      expect(released).toHaveLength(1);
      expect(JSON.parse(released[0]?.meta ?? '{}')).toEqual({ sweep: true, attempts: 1 });
      const queued = fixture.db
        .prepare(`SELECT payload FROM events WHERE change_id = ? AND kind = 'change.queued'`)
        .all(stopped) as Array<{ payload: string }>;
      expect(JSON.parse(queued.at(-1)?.payload ?? '{}')).toEqual({ retry: true, sweep: true });

      // It is claimable again — the whole point of re-entering it.
      const assignment = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;
      expect(assignment.changeId).toBe(stopped);
    } finally {
      fixture.close();
    }
  });

  it('is idempotent: a second pass changes no row and writes no event', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      addChange(fixture, {
        id: 'chg_escalated',
        chapter: 1,
        status: 'escalated',
        outcome: 'origin',
        attempts: QUEUE_MAX_ATTEMPTS - 1,
        commentId: addComment(fixture, 'cmt_i', 1),
      });
      const pending = addChange(fixture, { id: 'chg_head', chapter: 1 });
      addOpenStep(fixture, { id: 'stp_head', chapter: 1, changeId: pending });

      const first = sweepZombies(fixture.deps);
      expect(first.rows).toHaveLength(2);
      // Everything a pass can write: the rows, the ledger, the alert record (`meta`) and the
      // impact projection `stopChange` materializes. The second pass must leave all of it alone.
      const snapshot = () => ({
        changes: fixture.db.prepare('SELECT * FROM changes ORDER BY seq').all(),
        steps: fixture.db.prepare('SELECT * FROM steps ORDER BY step_id').all(),
        cascades: fixture.db.prepare('SELECT * FROM cascades ORDER BY id').all(),
        meta: fixture.db.prepare('SELECT * FROM meta ORDER BY k').all(),
        impact: fixture.db.prepare('SELECT * FROM change_impact ORDER BY change_id').all(),
        events: (fixture.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
        changeEvents: (fixture.db.prepare('SELECT COUNT(*) AS n FROM change_events').get() as { n: number }).n,
      });
      const before = snapshot();

      const second = sweepZombies(fixture.deps);

      expect(second.rows).toEqual([]);
      expect(second.lines).toEqual([]);
      expect(second.failures).toEqual([]);
      expect(snapshot()).toEqual(before);
    } finally {
      fixture.close();
    }
  });

  it('never touches a step with a live lease or a change that holds the lane', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      // A change claimed the ordinary way: it holds the lane, and its step's lease is alive.
      const held = addChange(fixture, { id: 'chg_held', chapter: 1 });
      const assignment = fixture.engine.next({ for: 'filing', session: 's1' }) as WriterAssignment;
      expect(assignment.changeId).toBe(held);
      const laneStep = store.getStep(fixture.db, assignment.stepId);
      const laneChange = store.getChange(fixture.db, held);

      // An escalated change whose open step is held by a live lease: a pass in flight.
      const stopped = addChange(fixture, {
        id: 'chg_live_stop',
        chapter: 2,
        status: 'escalated',
        outcome: 'origin',
        commentId: addComment(fixture, 'cmt_live', 2),
      });
      const liveStep = addOpenStep(fixture, { id: 'stp_live', chapter: 2, changeId: stopped, ageMs: ZOMBIE_GRACE_MS * 10 });
      const now = fixture.clock.now();
      store.insertLease(fixture.db, {
        id: 'lea_live',
        stepId: liveStep,
        changeId: stopped,
        cascadeId: null,
        lane: null,
        chapter: 2,
        isFront: 0,
        kind: 'change',
        session: 'writer-live',
        expectedRev: 0,
        acquiredAt: toIso(now),
        heartbeatAt: toIso(now),
        expiresAt: toIso(now + fixture.config.leaseTtlMs),
      });
      const liveRow = store.getStep(fixture.db, liveStep);
      const liveChange = store.getChange(fixture.db, stopped);

      const report = sweepZombies(fixture.deps);

      expect(report.rows).toEqual([]);
      expect(report.lines).toEqual([]);
      expect(store.getStep(fixture.db, liveStep)).toEqual(liveRow);
      expect(store.getStep(fixture.db, assignment.stepId)).toEqual(laneStep);
      expect(store.getChange(fixture.db, stopped)).toEqual(liveChange);
      expect(store.getChange(fixture.db, held)).toEqual(laneChange);
      expect(store.readLane(fixture.db).holder).toBe(held);
    } finally {
      fixture.close();
    }
  });

  it('re-queues a processing ghost, aborts an orphan cascade and sinks a ghost past its bound', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      // A claim whose process died before it recorded a step: `processing`, nothing in flight.
      const ghost = addChange(fixture, { id: 'chg_ghost', chapter: 1, status: 'processing' });
      const spent = addChange(fixture, {
        id: 'chg_ghost_spent',
        chapter: 2,
        status: 'processing',
        attempts: QUEUE_MAX_ATTEMPTS - 1,
      });
      // A ripple left open under a change no rule will move again.
      const orphanChange = addChange(fixture, {
        id: 'chg_orphan',
        chapter: 3,
        status: 'void',
        outcome: 'dropped',
        reason: droppedLine('superseded'),
        commentId: addComment(fixture, 'cmt_orphan', 3),
      });
      store.insertCascade(fixture.db, { id: 'csc_orphan', changeId: orphanChange, budget: '{}', openedAt: toIso(fixture.clock.now()) });

      const report = sweepZombies(fixture.deps);

      expect(report.failures).toEqual([]);
      expect(report.rows.map((row) => [row.kind, row.id, row.condition])).toEqual([
        ['cascade', 'csc_orphan', 'cascade-orphan'],
        ['change', ghost, 'processing-ghost'],
        ['change', spent, 'escalated-exhausted'],
      ]);
      expect(store.getCascade(fixture.db, 'csc_orphan')).toMatchObject({ status: 'aborted' });
      expect(store.listOpenCascades(fixture.db)).toEqual([]);
      // The ghost is re-entered with nothing of its dead claim left on it.
      expect(store.getChange(fixture.db, ghost)).toMatchObject({
        status: 'pending',
        attempts: 1,
        outcome: null,
        reason: null,
        started_at: null,
        finished_at: null,
        cascade_id: null,
      });
      expect(store.getChange(fixture.db, spent)).toMatchObject({ status: 'void', outcome: 'dropped' });
      // The sink is the queue's own sentence, and the filing behind it is the reader's refusal.
      expect(store.getChange(fixture.db, spent)?.reason).toBe(queueAttemptsLine(QUEUE_MAX_ATTEMPTS));
      expect(store.countProcessing(fixture.db)).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('sinks a superseded attempt without telling its reader «отклонена» — no push, no alert', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      addComment(fixture, 'cmt_landed', 1);
      addComment(fixture, 'cmt_lost', 2);
      // A device, so a `void` decision would really be queued for the reader.
      addDevice(fixture);
      const superseded = addChange(fixture, {
        id: 'chg_superseded',
        chapter: 1,
        status: 'escalated',
        outcome: 'origin',
        commentId: 'cmt_landed',
      });
      addChange(fixture, { id: 'chg_sibling', chapter: 1, status: 'done', outcome: 'applied', commentId: 'cmt_landed' });
      const exhausted = addChange(fixture, {
        id: 'chg_exhausted',
        chapter: 2,
        status: 'escalated',
        outcome: 'origin',
        attempts: QUEUE_MAX_ATTEMPTS - 1,
        commentId: 'cmt_lost',
      });

      const report = sweepZombies(fixture.deps);

      expect(report.rows.map((row) => row.condition)).toEqual(['escalated-superseded', 'escalated-exhausted']);
      // The filing that landed keeps its landing, so nothing is announced for its chapter …
      const pushes = fixture.db.prepare('SELECT chapter FROM push_outbox ORDER BY chapter').all() as Array<{
        chapter: number;
      }>;
      expect(pushes.map((row) => row.chapter)).toEqual([2]);
      // … while the exhausted filing — the reader's own refusal — is still spoken.
      expect(fixture.alerts.map((alert) => alert.changeId)).toEqual([exhausted]);
      expect(store.getChange(fixture.db, superseded)).toMatchObject({ status: 'void', outcome: 'dropped' });
    } finally {
      fixture.close();
    }
  });

  it('sinks an escalated premise whose chapter already waits under another one', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      // An unwritten chapter, so the premise rule leaves both rows alone: one is queued, the other
      // is a legacy stop. The partial unique index makes re-entering it an error, not a retry —
      // so the legacy row is written first and stopped, then the live premise is queued beside it.
      const legacy = addChange(fixture, {
        id: 'chg_p_old',
        chapter: 5,
        premise: 1,
        status: 'escalated',
        outcome: 'origin',
      });
      const waiting = addChange(fixture, { id: 'chg_p_live', chapter: 5, premise: 1 });

      const report = sweepZombies(fixture.deps);

      expect(report.failures).toEqual([]);
      expect(report.rows.map((row) => [row.id, row.condition])).toEqual([[legacy, 'escalated-superseded']]);
      expect(store.getChange(fixture.db, legacy)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        reason: droppedLine('superseded'),
      });
      expect(store.getChange(fixture.db, waiting)?.status).toBe('pending');
    } finally {
      fixture.close();
    }
  });

  it('reports a premise it settles even inside a heal narrowed to another change', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      book(fixture);
      const ghost = addChange(fixture, { id: 'chg_ghost', chapter: 1, status: 'processing' });
      // A premise on a written chapter can never be drafted, whoever's heal is running — and a
      // filing is never closed without a line, so the narrowed pass still reports it.
      const dead = addChange(fixture, {
        id: 'chg_dead_premise',
        chapter: 2,
        premise: 1,
        commentId: addComment(fixture, 'cmt_dead', 2),
      });

      const report = sweepZombies(fixture.deps, { only: { changeId: ghost } });

      expect(report.rows.map((row) => [row.id, row.condition])).toEqual([
        [dead, 'premise-stale'],
        [ghost, 'processing-ghost'],
      ]);
      expect(store.getChange(fixture.db, dead)).toMatchObject({ status: 'void', outcome: 'dropped' });
    } finally {
      fixture.close();
    }
  });

  it('keeps the sweep going when one row cannot be changed, and logs the failure', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    const lines: string[] = [];
    try {
      book(fixture);
      fixture.deps.log = (line) => lines.push(line);
      const poison = addChange(fixture, { id: 'chg_poison', chapter: 1, status: 'escalated', outcome: 'origin' });
      const healthy = addChange(fixture, { id: 'chg_healthy', chapter: 2, status: 'escalated', outcome: 'origin' });
      // A row the engine cannot write: the sweep's own try/catch is what this proves.
      fixture.db.exec(
        `CREATE TRIGGER test_refuse_poison BEFORE UPDATE ON changes WHEN OLD.id = 'chg_poison'
         BEGIN SELECT RAISE(ABORT, 'test: poisoned row'); END`,
      );

      const report = fixture.engine.reconcile() as {
        zombies: { rows: Array<{ id: string }>; failures: Array<{ id: string; code: string }> };
      };

      expect(report.zombies.failures).toEqual([{ id: poison, code: 'UNKNOWN' }]);
      expect(report.zombies.rows.map((row) => row.id)).toEqual([healthy]);
      expect(lines).toContain(`zombie sweep: failed ${poison} (UNKNOWN)`);
      // The rest of the sweep ran: the healthy row was re-entered, the wedged one still stands.
      expect(store.getChange(fixture.db, healthy)?.status).toBe('pending');
      expect(store.getChange(fixture.db, poison)?.status).toBe('escalated');
    } finally {
      fixture.close();
    }
  });
});
