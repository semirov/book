/**
 * The drainer (BOOK-173, BOOK-DOC-75 §4, §6) — the loop's arithmetic, over a real ledger.
 *
 * Every case starts where the origin pass left the book: a landed patch, a stored plan, a change
 * closed `ripple`. The chapter runner is the seam: a test scripts what one chapter's pass did
 * (which facts its repair retired), and the loop's own rows — `change_plans.iterations`, the plan
 * it recomputes, the verification it prints — are what is asserted.
 *
 *   (a) two mandatory nodes in two chapters → two iterations, both landed, `done`;
 *   (b) the fifth node priced over the 4 000 characters → `wide` before the second chapter;
 *   (d) a repair that keeps the claim's wording → the repaired node leaves the mandatory set and
 *       the loop **continues**; a node that returns through a *new* edge → `CLOSURE_UNSTABLE`.
 */

import { describe, expect, it } from 'vitest';

import { claimPlan, releasePlanClaim, type RipplePlan } from '../../../src/ledger/graph/plan.ts';
import { drainAll, drainRipple, frameProbe, readIterations, type ChapterRun } from '../../../src/writer/ripple/drain.ts';
import { drainablePlans, latestPlan } from '../../../src/engine/ripple.ts';
import type { WriterAssignment } from '@book/shared';
import type { Harness } from '../harness.ts';
import {
  CONSEQUENCES,
  ORIGIN,
  chaptersFixture,
  retire,
  rippleGraph,
  rippleHarness,
  seedEdge,
  statusPatch,
} from './fixtures.ts';

type Landed = { harness: Harness; changeId: string; plan: RipplePlan; planRowId: string };

/** Run the origin pass: the patch lands and the engine freezes the plan the drainer will read. */
async function landed(before?: (harness: Harness) => void): Promise<Landed> {
  const harness = await rippleHarness();
  rippleGraph(harness);
  before?.(harness);
  const changeId = (
    harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'pending'`).get(ORIGIN) as {
      id: string;
    }
  ).id;
  // The patch, the causality judge, the local judge, then the pair (a non-empty closure).
  harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');
  const result = await harness.run({ lanes: ['fwd'] });
  expect(result.status).toBe('closed');
  const stored = latestPlan(harness.fixture.db, changeId);
  if (stored === null) throw new Error('the landing stored no plan');
  return { harness, changeId, plan: stored.plan, planRowId: stored.planRowId };
}

/**
 * One real ripple chapter through the engine's own door: the paragraph is rewritten, the claim's
 * wording stays in it. That is the repair the drainer used to park on — the node it just patched
 * came back mandatory because the recompute did not know it had been executed.
 */
function repairKeepingClaim(harness: Harness, changeId: string, chapter: number): ChapterRun {
  const own = harness.fixture.engine.openChapterPass(chapter, 'drain-test', changeId) as WriterAssignment | null;
  if (own === null) throw new Error('the ripple door opened no step');
  harness.fixture.engine.start(own.leaseId);
  const raw = chaptersFixture()[chapter];
  if (raw === undefined || !raw.includes('смена стоит')) throw new Error(`fixture ch${String(chapter)} has no «смена стоит»`);
  harness.fixture.writeChapter(chapter, raw.replace('смена стоит', 'смена идёт'));
  harness.fixture.engine.land(own.leaseId);
  return { landed: true, changedChars: 90, costUsd: 0.11 };
}

describe('the drainer', () => {
  it('runs one chapter per iteration until no mandatory node is left, then verifies', async () => {
    const { harness, changeId, plan, planRowId } = await landed();
    try {
      const touched: number[] = [];
      const outcome = await drainAll({
        db: harness.fixture.db,
        planRowId,
        plan,
        frameOk: frameProbe(harness.fixture.db),
        runChapter: async (chapter, nodes) => {
          touched.push(chapter);
          retire(harness.fixture.db, nodes.map((node) => node.factId), changeId);
          return { landed: true, changedChars: 120, costUsd: 0.12 };
        },
      });

      expect(touched).toEqual([12, 19]);
      expect(outcome.status).toBe('done');
      expect(outcome.iterations).toHaveLength(2);
      expect(outcome.iterations.map((entry) => entry.chapter)).toEqual([12, 19]);
      expect(outcome.iterations[0]?.nodes).toEqual(['f:d:допуск@ch12#status']);
      expect(outcome.verification?.ok).toBe(true);
      // The journal is a row, not a variable: a second process reads the same two iterations.
      expect(readIterations(harness.fixture.db, planRowId)).toHaveLength(2);
      // And the plan is no longer work: every mandatory chapter has been taken.
      expect(drainablePlans(harness.fixture.db)).toEqual([]);
      // The change is still the ripple it closed as; the drainer never rewrites that.
      expect(
        harness.fixture.db.prepare('SELECT outcome FROM changes WHERE id = ?').get(changeId) as { outcome: string },
      ).toEqual({ outcome: 'ripple' });
    } finally {
      await harness.close();
    }
  });

  it('takes one chapter per call: a process iteration is one chapter, the journal is the state', async () => {
    const { harness, changeId, plan, planRowId } = await landed();
    try {
      const run = async (_chapter: number, nodes: Array<{ factId: string }>) => {
        retire(harness.fixture.db, nodes.map((node) => node.factId), changeId);
        return { landed: true, changedChars: 100, costUsd: 0.12 };
      };
      const first = await drainRipple({ db: harness.fixture.db, planRowId, plan, frameOk: frameProbe(harness.fixture.db), runChapter: run });
      expect(first.status).toBe('continued');
      expect(first.iterations.map((entry) => entry.chapter)).toEqual([12]);
      expect(first.verification).toBeNull();
      // The second process iteration reads the journal and takes the next chapter — not the first.
      const second = await drainRipple({
        db: harness.fixture.db,
        planRowId,
        plan: first.plan,
        frameOk: frameProbe(harness.fixture.db),
        runChapter: run,
      });
      expect(second.status).toBe('done');
      expect(second.iterations.map((entry) => entry.chapter)).toEqual([12, 19]);
    } finally {
      await harness.close();
    }
  });

  it('is wide before the second chapter when the characters would cross 4 000', async () => {
    // Two long claims before the plan is frozen: 2 × 1 200 characters is over half the bound.
    const long = 'Д'.repeat(1_200);
    const { harness, changeId, plan, planRowId } = await landed((own) => {
      for (const chapter of CONSEQUENCES) {
        own.fixture.db
          .prepare('UPDATE facts SET statement = ? WHERE id = ?')
          .run(long, `f:d:допуск@ch${String(chapter)}#status`);
      }
    });
    try {
      const touched: number[] = [];
      const outcome = await drainAll({
        db: harness.fixture.db,
        planRowId,
        plan,
        frameOk: frameProbe(harness.fixture.db),
        runChapter: async (chapter, nodes) => {
          touched.push(chapter);
          retire(harness.fixture.db, nodes.map((node) => node.factId), changeId);
          return { landed: true, changedChars: 2_400, costUsd: 0.12 };
        },
      });

      // The estimate alone stopped it: one chapter ran, the second was never touched.
      expect(touched).toEqual([12]);
      expect(outcome.status).toBe('wide');
      // The park is a sentence for the author; the code stays in the log and in the journal.
      expect(outcome.reason).toContain('замыкание вышло за границы');
      expect(outcome.verification).toBeNull();
      const parked = harness.fixture.db
        .prepare('SELECT parked_at, park_reason FROM change_plans WHERE id = ?')
        .get(planRowId) as { parked_at: string | null; park_reason: string | null };
      expect(parked.parked_at).not.toBeNull();
      expect(parked.park_reason).not.toContain('CLOSURE_BOUND');
      // A parked plan is not work: the next driver finds nothing to drain.
      expect(drainablePlans(harness.fixture.db)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('keeps draining when the repair keeps the claim’s wording: the node is not mandatory again', async () => {
    const { harness, changeId, plan, planRowId } = await landed();
    try {
      const outcome = await drainRipple({
        db: harness.fixture.db,
        planRowId,
        plan,
        frameOk: frameProbe(harness.fixture.db),
        // A real patch through the ripple door: ch12's paragraph is rewritten, the claim's own
        // words («Допуск всё ещё выдан») stay in it — the case that used to park the plan.
        runChapter: async (chapter) => repairKeepingClaim(harness, changeId, chapter),
      });

      const node = outcome.plan.nodes.find((entry) => entry.factId === 'f:d:допуск@ch12#status');
      // Executed by this change, so it is not mandatory again — and the loop owes the next chapter.
      expect(node?.mandatory).toBe(false);
      expect(outcome.plan.nodes.filter((entry) => entry.mandatory).map((entry) => entry.chapter)).toEqual([19]);
      expect(outcome.status).toBe('continued');
      expect(outcome.iterations).toHaveLength(1);
      expect(readIterations(harness.fixture.db, planRowId)).toHaveLength(1);
      const parked = harness.fixture.db
        .prepare('SELECT parked_at FROM change_plans WHERE id = ?')
        .get(planRowId) as { parked_at: string | null };
      expect(parked.parked_at).toBeNull();
      // …and the claim it kept is still a live fact: a repair never retires a claim it left standing.
      expect(
        harness.fixture.db.prepare('SELECT invalidated_at FROM facts WHERE id = ?').get('f:d:допуск@ch12#status'),
      ).toEqual({ invalidated_at: null });
    } finally {
      await harness.close();
    }
  });

  it('is CLOSURE_UNSTABLE when a node comes back through a new edge', async () => {
    const { harness, changeId, plan, planRowId } = await landed();
    try {
      const outcome = await drainRipple({
        db: harness.fixture.db,
        planRowId,
        plan,
        frameOk: frameProbe(harness.fixture.db),
        runChapter: async () => {
          // ch12's claim is repaired and retired, so it leaves the closure; the closure now
          // reaches ch19 by a *different* edge — the cause of its mandatory state moved while the
          // book was being patched.
          retire(harness.fixture.db, ['f:d:допуск@ch12#status'], changeId);
          seedEdge(harness.fixture.db, {
            id: 'edg_doc_19_follows',
            from: 'f:d:допуск@ch05#status',
            to: 'f:d:допуск@ch19#status',
            chapter: 19,
            kind: 'follows',
          });
          return { landed: true, changedChars: 90, costUsd: 0.11 };
        },
      });

      expect(outcome.status).toBe('unstable');
      expect(outcome.reason).toContain('замыкание не сходится');
      expect(outcome.reason).not.toContain('CLOSURE_UNSTABLE');
      const node = outcome.plan.nodes.find((entry) => entry.factId === 'f:d:допуск@ch19#status');
      expect(node?.reason).toBe('CAUSE_CHANGED:edg_doc_19_follows');
      const parked = harness.fixture.db
        .prepare('SELECT parked_at FROM change_plans WHERE id = ?')
        .get(planRowId) as { parked_at: string | null };
      expect(parked.parked_at).not.toBeNull();
      expect(drainablePlans(harness.fixture.db)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('journals a refused chapter, then parks the plan on the second refusal of the same node', async () => {
    const { harness, plan, planRowId } = await landed();
    try {
      // First refusal: a row, the money it burnt, the code — and the chapter is still owed.
      const first = await drainRipple({
        db: harness.fixture.db,
        planRowId,
        plan,
        frameOk: frameProbe(harness.fixture.db),
        runChapter: async () => ({ landed: false, changedChars: 0, costUsd: 0.03, reason: 'гейты отказали', code: 'RIGHTS_REQUIRED' }),
      });
      expect(first.status).toBe('chapter_refused');
      expect(first.reason).toContain('гейты отказали');
      const journal = readIterations(harness.fixture.db, planRowId);
      expect(journal).toHaveLength(1);
      expect(journal[0]).toMatchObject({ chapter: 12, landed: false, code: 'RIGHTS_REQUIRED', costUsd: 0.03 });
      // One refusal is not a verdict: the plan is still work.
      expect(drainablePlans(harness.fixture.db)).toHaveLength(1);

      // Second refusal of the same node: the book said no, and the plan is parked for the author.
      const second = await drainRipple({
        db: harness.fixture.db,
        planRowId,
        plan,
        frameOk: frameProbe(harness.fixture.db),
        runChapter: async () => ({ landed: false, changedChars: 0, costUsd: 0.03, reason: 'гейты отказали', code: 'RIGHTS_REQUIRED' }),
      });
      expect(second.status).toBe('parked');
      expect(second.reason).toContain('дважды не приняла правку');
      expect(second.reason).not.toContain('RIPPLE_REFUSED');
      expect(readIterations(harness.fixture.db, planRowId)).toHaveLength(2);
      const parked = harness.fixture.db
        .prepare('SELECT parked_at, park_reason FROM change_plans WHERE id = ?')
        .get(planRowId) as { parked_at: string | null; park_reason: string | null };
      expect(parked.parked_at).not.toBeNull();
      expect(parked.park_reason).toContain('дважды не приняла правку');
      // Nothing may re-run a parked plan — not this driver, not the next one.
      expect(drainablePlans(harness.fixture.db)).toEqual([]);
      expect(ORIGIN).toBe(5);
    } finally {
      await harness.close();
    }
  });

  it('skips a plan another process holds the claim on', async () => {
    const { harness, planRowId } = await landed();
    try {
      expect(claimPlan(harness.fixture.db, planRowId, 'other-process', Date.now())).toBe(true);
      expect(drainablePlans(harness.fixture.db)).toEqual([]);
      // The claim is released the same way the CLI releases it, and the plan is work again.
      releasePlanClaim(harness.fixture.db, planRowId, 'other-process');
      expect(drainablePlans(harness.fixture.db)).toHaveLength(1);
      // …and only the holder releases it: a stranger's release is a no-op.
      expect(claimPlan(harness.fixture.db, planRowId, 'holder', Date.now())).toBe(true);
      releasePlanClaim(harness.fixture.db, planRowId, 'stranger');
      expect(drainablePlans(harness.fixture.db)).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
