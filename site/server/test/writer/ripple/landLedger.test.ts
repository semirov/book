/**
 * The landing and the ledger, as **one write** (BOOK-173 review, fixes 3 and 4) — real engine,
 * real ingest, scripted model:
 *
 *   · a plan frozen after the revision commits is a plan a crash can lose, and a re-land writes a
 *     second row whose bounds are per plan. Here the plan is written inside the ingest's own
 *     transaction: a trigger that aborts the insert leaves **neither** the revision nor the plan,
 *     and a second land of the same step updates the one row;
 *   · a mention bound to a block id dangles the moment a patch replaces that block. Here the
 *     mention is re-bound in the same transaction, `assertedFacts` reads the chapter's text rather
 *     than an id, and the node it names stays mandatory — until a contradicting patch removes the
 *     claim, which retires the fact and its edges;
 *   · a revision the site's watcher published first still gets its plan (round 3, fix 1): the
 *     ingest answers `unchanged`, and the ledger is settled anyway, so the change cannot close
 *     `applied` with the ripple silently unplanned.
 */

import { describe, expect, it } from 'vitest';

import { assertedFacts, walk } from '../../../src/ledger/graph/edges.ts';
import { buildPlan } from '../../../src/ledger/graph/plan.ts';
import { listStages } from '../../../src/stages/repo.ts';
import type { WriterAssignment } from '@book/shared';

import { CONSEQUENCES, ORIGIN, blockOf, chaptersFixture, rippleGraph, rippleHarness, statusPatch } from './fixtures.ts';

const CH12 = CONSEQUENCES[0];

/** The engine's own door onto the pending filing — the pass the test then drives by hand. */
function assignmentFiling(harness: Awaited<ReturnType<typeof rippleHarness>>): WriterAssignment {
  const assignment = harness.fixture.engine.next({ for: 'filing', session: 'ledger-test' }) as WriterAssignment | null;
  if (assignment === null) throw new Error('the fixture offered no filing');
  return assignment;
}

function land(harness: Awaited<ReturnType<typeof rippleHarness>>, leaseId: string): unknown {
  return harness.fixture.engine.land(leaseId);
}

/** The chapter's text with one phrase replaced — a patch, not a rewrite. */
function patched(chapter: number, from: string, to: string): string {
  const raw = chaptersFixture()[chapter];
  if (raw === undefined || !raw.includes(from)) throw new Error(`fixture ch${String(chapter)} has no «${from}»`);
  return raw.replace(from, to);
}

describe('the plan is written inside the land transaction', () => {
  it('keeps one plan row per change across two lands of the same step', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const assignment = assignmentFiling(harness);
      harness.fixture.engine.start(assignment.leaseId);
      const db = harness.fixture.db;
      const changeId = (
        db.prepare(`SELECT id FROM changes WHERE chapter = ? ORDER BY seq DESC`).get(ORIGIN) as { id: string }
      ).id;

      harness.fixture.writeChapter(ORIGIN, patched(ORIGIN, 'выдан', 'аннулирован'));
      land(harness, assignment.leaseId);
      const firstRev = (db.prepare('SELECT rev FROM chapters WHERE n = ?').get(ORIGIN) as { rev: number }).rev;
      const first = db.prepare('SELECT id, outcome, iterations FROM change_plans WHERE change_id = ?').all(changeId) as Array<{
        id: string;
        outcome: string;
        iterations: string;
      }>;
      expect(first).toHaveLength(1);
      // A journal from a chapter already drained — the re-land must not reset it.
      db.prepare(`UPDATE change_plans SET iterations = '[{"chapter":12,"landed":true,"changedChars":90,"costUsd":0.14}]'`).run();

      // The second land of the *same* step: a different word, the same change.
      harness.fixture.writeChapter(ORIGIN, patched(ORIGIN, 'Ковалёву на руки', 'Ковалёву Ивану на руки'));
      land(harness, assignment.leaseId);

      const second = db.prepare('SELECT id, iterations FROM change_plans WHERE change_id = ?').all(changeId) as Array<{
        id: string;
        iterations: string;
      }>;
      expect(second).toHaveLength(1);
      expect(second[0]?.id).toBe(first[0]?.id);
      // The second land really did publish (and therefore really did re-plan): one more revision.
      expect((db.prepare('SELECT rev FROM chapters WHERE n = ?').get(ORIGIN) as { rev: number }).rev).toBe(firstRev + 1);
      // The bounds are cumulative per change: the journal is the spend, and it survived the re-plan.
      expect(second[0]?.iterations).toContain('"chapter":12');
    } finally {
      await harness.close();
    }
  });

  it('a land that cannot write its plan writes no revision either', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const assignment = assignmentFiling(harness);
      harness.fixture.engine.start(assignment.leaseId);
      const db = harness.fixture.db;
      const before = {
        rev: (db.prepare('SELECT rev FROM chapters WHERE n = ?').get(ORIGIN) as { rev: number }).rev,
        revisions: (db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(ORIGIN) as { n: number }).n,
        versions: (db.prepare('SELECT COUNT(*) AS n FROM block_versions').get() as { n: number }).n,
      };
      db.exec(
        `CREATE TRIGGER change_plans_boom BEFORE INSERT ON change_plans
           BEGIN SELECT RAISE(ABORT, 'plan boom'); END`,
      );

      harness.fixture.writeChapter(ORIGIN, patched(ORIGIN, 'выдан', 'аннулирован'));
      expect(() => land(harness, assignment.leaseId)).toThrow(/plan boom/u);

      // Nothing landed: not the plan, and not the revision it would have been attached to.
      expect(db.prepare('SELECT COUNT(*) AS n FROM change_plans').get()).toEqual({ n: 0 });
      expect((db.prepare('SELECT rev FROM chapters WHERE n = ?').get(ORIGIN) as { rev: number }).rev).toBe(before.rev);
      expect((db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(ORIGIN) as { n: number }).n).toBe(
        before.revisions,
      );
      expect((db.prepare('SELECT COUNT(*) AS n FROM block_versions').get() as { n: number }).n).toBe(before.versions);

      // With the plan writable, the same landing publishes both in one write.
      db.exec('DROP TRIGGER change_plans_boom');
      land(harness, assignment.leaseId);
      expect((db.prepare('SELECT COUNT(*) AS n FROM change_plans').get() as { n: number }).n).toBeGreaterThan(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(ORIGIN) as { n: number }).n).toBe(
        before.revisions + 1,
      );
    } finally {
      await harness.close();
    }
  });
});

describe('a patched paragraph keeps its fact asserted — by text, not by block id', () => {
  it('re-binds the mention in the land transaction and the node stays mandatory', async () => {
    const harness = await rippleHarness();
    try {
      const graph = rippleGraph(harness);
      const db = harness.fixture.db;
      const before = blockOf(db, CH12, 0);
      // The origin pass runs first: the change closes `ripple` and the plan names ch12.
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');
      const changeId = (
        db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'done'`).get(ORIGIN) as { id: string }
      ).id;

      // A patch of the paragraph that carries the claim: the block id changes, the phrase stays.
      const own = harness.fixture.engine.openChapterPass(CH12, 'ledger-test', changeId) as WriterAssignment | null;
      if (own === null) throw new Error('the ripple door opened no step');
      harness.fixture.engine.start(own.leaseId);
      harness.fixture.writeChapter(CH12, patched(CH12, 'смена стоит', 'смена идёт'));
      land(harness, own.leaseId);

      const after = blockOf(db, CH12, 0);
      expect(after.id).not.toBe(before.id);
      // The mention moved with the text, inside the same transaction as the revision.
      const mention = db
        .prepare(`SELECT block_id AS blockId, start, end, witness FROM mentions WHERE fact_id = ?`)
        .get(graph.deadline) as { blockId: string; start: number; end: number; witness: string };
      expect(mention.blockId).toBe(after.id);
      expect(mention.witness).toBe('Допуск всё ещё выдан');
      expect(assertedFacts(db).has(graph.deadline)).toBe(true);

      // …the fact is still live: the paragraph moved under it, the claim did not leave the book.
      expect(db.prepare('SELECT invalidated_at FROM facts WHERE id = ?').get(graph.deadline)).toEqual({
        invalidated_at: null,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM edges WHERE from_fact = ? OR to_fact = ?').get(graph.deadline, graph.deadline)).toEqual({ n: 1 });

      // …and the plan still puts that node in the closure as mandatory.
      const plan = buildPlan({
        db,
        changeId: 'chg_asserted',
        chapter: ORIGIN,
        // The change moved the document's *status* — the component the ch12 edge consumes.
        seeds: [{ factId: graph.seed, changed: ['status'] }],
        before: '',
        after: '',
      });
      const node = plan.nodes.find((entry) => entry.factId === graph.deadline);
      expect(node?.mandatory).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('a contradicting patch retires the fact and its edges, and no walk reaches the node', async () => {
    const harness = await rippleHarness();
    try {
      const graph = rippleGraph(harness);
      const db = harness.fixture.db;
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');
      const changeId = (
        db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'done'`).get(ORIGIN) as { id: string }
      ).id;
      const own = harness.fixture.engine.openChapterPass(CH12, 'ledger-test', changeId) as WriterAssignment | null;
      if (own === null) throw new Error('the ripple door opened no step');
      harness.fixture.engine.start(own.leaseId);
      // The claim itself is gone: «Допуск всё ещё выдан» becomes «Допуск отозван».
      harness.fixture.writeChapter(CH12, patched(CH12, 'Допуск всё ещё выдан', 'Допуск отозван'));
      land(harness, own.leaseId);

      expect(assertedFacts(db).has(graph.deadline)).toBe(false);
      // The landing retired it in its own transaction: the row stays (a fact is never deleted),
      // the change that made it false is recorded…
      expect(db.prepare('SELECT invalidated_by_change AS by FROM facts WHERE id = ?').get(graph.deadline)).toEqual({
        by: changeId,
      });
      // …and `facts_retire_edges` took its incident edges, so a later walk cannot reach the node.
      expect(db.prepare('SELECT COUNT(*) AS n FROM edges WHERE from_fact = ? OR to_fact = ?').get(graph.deadline, graph.deadline)).toEqual({ n: 0 });
      const reached = walk(db, [graph.seed]).nodes.map((node) => node.factId);
      expect(reached).not.toContain(graph.deadline);
      const plan = buildPlan({
        db,
        changeId: 'chg_unasserted',
        chapter: ORIGIN,
        seeds: [{ factId: graph.seed, changed: ['status'] }],
        before: '',
        after: '',
      });
      expect(plan.nodes.find((entry) => entry.factId === graph.deadline)).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('never invalidates a fact another chapter still asserts', async () => {
    const harness = await rippleHarness();
    try {
      const graph = rippleGraph(harness);
      const db = harness.fixture.db;
      // The same claim is mentioned twice: ch12 states it, ch19 quotes it. A patch of ch12 overruns
      // its carrier, but the book still asserts the claim — so the fact stays live and keeps its
      // edges, and only the mention ch12 lost stops being an assertion.
      db.prepare(
        `INSERT INTO mentions
           (span_id, block_id, chapter, start, end, kind, fact_id, thread_id, resolved_by_change, role, witness, edge_path)
         VALUES ('span_ch19:claim', ?, 19, 0, 22, 'fact', ?, NULL, NULL, 'assert', 'По выданному допуску', '[]')`,
      ).run(blockOf(db, 19, 0).id, graph.deadline);
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS');
      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');
      const changeId = (
        db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'done'`).get(ORIGIN) as { id: string }
      ).id;
      const own = harness.fixture.engine.openChapterPass(CH12, 'ledger-test', changeId) as WriterAssignment | null;
      if (own === null) throw new Error('the ripple door opened no step');
      harness.fixture.engine.start(own.leaseId);
      harness.fixture.writeChapter(CH12, patched(CH12, 'Допуск всё ещё выдан', 'Допуск отозван'));
      land(harness, own.leaseId);

      expect(assertedFacts(db).has(graph.deadline)).toBe(true);
      expect(db.prepare('SELECT invalidated_at FROM facts WHERE id = ?').get(graph.deadline)).toEqual({
        invalidated_at: null,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM edges WHERE from_fact = ? OR to_fact = ?').get(graph.deadline, graph.deadline)).toEqual({ n: 1 });
    } finally {
      await harness.close();
    }
  });
});

describe('a revision the watcher published first still gets its plan', () => {
  it('settles the ledger of a landing the ingest answers `unchanged` for, and closes ripple', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const db = harness.fixture.db;
      const changeId = (
        db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'pending'`).get(ORIGIN) as { id: string }
      ).id;
      // The site's watcher publishes the pass's file first (same process, `ingest/watcher.ts`):
      // the engine's own ingest then finds the bytes already published and answers `unchanged`.
      harness.hooks.beforeCall = (name) => {
        if (name === 'land') harness.ingest(ORIGIN);
      };
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS');

      expect((await harness.run({ lanes: ['fwd'] })).status).toBe('closed');

      // Exactly one plan row — `storePlan` is idempotent per change, so the second door added none.
      const rows = db.prepare('SELECT outcome FROM change_plans WHERE change_id = ?').all(changeId) as Array<{
        outcome: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.outcome).toBe('ripple');
      // The pass acted on it: the plan line is on the origin's `read` stage, and the change closes
      // as the ripple it is instead of `applied` with a closure nobody planned.
      expect(listStages(db, ORIGIN).some((stage) => stage.stage === 'read' && stage.summary.includes('правка задела'))).toBe(
        true,
      );
      expect(db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(changeId)).toEqual({
        status: 'done',
        outcome: 'ripple',
      });
      // And the landing published no second revision: the watcher's is the one the plan prices.
      expect((db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = ?').get(ORIGIN) as { n: number }).n).toBe(2);
    } finally {
      await harness.close();
    }
  });
});
