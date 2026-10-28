/**
 * The ripple at the point of landing (BOOK-173, BOOK-DOC-75 §3, §7) — real engine, real pass,
 * scripted model:
 *
 *   · a phrase patch whose closure stands two mandatory nodes in two chapters → `ripple`: the plan
 *     is computed by the engine at `land`, stored and printed on the origin pass's `read` line,
 *     the gates still run, and the change closes `ripple`;
 *   · a patch whose block names no live fact → `local`: nothing to react to, and the pass is the
 *     pass it was before this feature;
 *   · a judge that answers `GAP` → the change is escalated with the sentence and no gate is asked.
 */

import { describe, expect, it } from 'vitest';

import { listStages } from '../../../src/stages/repo.ts';
import type { RipplePlan } from '../../../src/ledger/graph/plan.ts';
import { ORIGIN, rippleGraph, rippleHarness, statusPatch } from './fixtures.ts';

function planRow(db: Parameters<typeof listStages>[0], changeId: string): { outcome: string; closure: string } | undefined {
  return db.prepare('SELECT outcome, closure FROM change_plans WHERE change_id = ? ORDER BY created_at LIMIT 1').get(changeId) as
    | { outcome: string; closure: string }
    | undefined;
}

function changeOf(db: Parameters<typeof listStages>[0], changeId: string): { status: string; outcome: string | null } | undefined {
  return db.prepare('SELECT status, outcome FROM changes WHERE id = ?').get(changeId) as
    | { status: string; outcome: string | null }
    | undefined;
}

describe('the plan the engine computes at land', () => {
  it('stores a ripple plan with two mandatory nodes and closes the change as ripple', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const changeId = (
        harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'pending'`).get(ORIGIN) as {
          id: string;
        }
      ).id;
      // The patch, the causality judge, the local judge, then the pair: a non-empty closure is a
      // Tier 2 trigger (BOOK-DOC-80), and the judge of the ripple is asked before either.
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS', 'HOLDS', 'HOLDS');

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');

      // 1. The plan: ripple, two mandatory nodes, both in chapters the patch never touched.
      const row = planRow(harness.fixture.db, changeId);
      expect(row?.outcome).toBe('ripple');
      const plan = JSON.parse(row?.closure ?? '{}') as RipplePlan;
      const mandatory = plan.nodes.filter((node) => node.mandatory);
      expect(mandatory.map((node) => node.chapter).sort()).toEqual([12, 19]);
      expect(plan.seeds.map((seed) => seed.factId)).toEqual(['f:d:допуск@ch05#status']);
      expect(plan.seeds[0]?.changed).toEqual(['status']);
      expect(plan.edgeDetail).toHaveLength(2);

      // 2. The reader's line, on the origin pass, from the plan and nothing else.
      const stages = listStages(harness.fixture.db, ORIGIN);
      const line = stages.find((stage) => stage.summary.includes('правка задела'));
      expect(line?.stage).toBe('read');
      expect(line?.summary).toContain('2 глав');
      expect(line?.summary).toContain('2 обязательных');
      expect(line?.summary).toContain('$0.28');

      // 3. The change: done, and `ripple` — not `applied`.
      expect(changeOf(harness.fixture.db, changeId)).toMatchObject({ status: 'done', outcome: 'ripple' });
      // 4. The gates ran for the origin chapter: the point patch is still gated as before.
      expect(harness.engineCalls.filter((call) => call === 'verdict')).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  it('is local when the patched block names no live fact: today’s flow, unchanged', async () => {
    const harness = await rippleHarness();
    try {
      const changeId = (
        harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'pending'`).get(ORIGIN) as {
          id: string;
        }
      ).id;
      harness.script.push(statusPatch(harness), 'HOLDS', 'HOLDS');

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('closed');
      expect(planRow(harness.fixture.db, changeId)?.outcome).toBe('local');
      expect(changeOf(harness.fixture.db, changeId)).toMatchObject({ status: 'done', outcome: 'applied' });
      const stages = listStages(harness.fixture.db, ORIGIN);
      expect(stages.some((stage) => stage.summary.includes('правка задела'))).toBe(false);
      // BOOK-DOC-80: an empty closure buys no causality question and no full pair — one local
      // judge call after the patch, and the record says the change was read locally.
      expect(harness.calls).toHaveLength(2);
      expect(harness.engineCalls.filter((call) => call === 'nextGate')).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('escalates a GAP from the judge with its sentence, and asks no gate', async () => {
    const harness = await rippleHarness();
    try {
      rippleGraph(harness);
      const changeId = (
        harness.fixture.db.prepare(`SELECT id FROM changes WHERE chapter = ? AND status = 'pending'`).get(ORIGIN) as {
          id: string;
        }
      ).id;
      harness.script.push(statusPatch(harness), 'GAP: «Допуск выдан» в главе 12 стало ложным, правок в замыкании нет.');

      const result = await harness.run({ lanes: ['fwd'] });
      expect(result.status).toBe('parked');
      expect(result.reason).toContain('замыкание не держится');
      expect(changeOf(harness.fixture.db, changeId)).toMatchObject({ status: 'escalated' });
      // Nothing else was written: the closure has no patch, and no gate was asked.
      expect(harness.engineCalls).not.toContain('nextGate');
      expect(harness.engineCalls).not.toContain('verdict');
      const plan = planRow(harness.fixture.db, changeId);
      expect(plan?.outcome).toBe('ripple');
      expect(JSON.parse(plan?.closure ?? '{}').patches).toEqual([]);
      // The point patch stayed in the book: the refusal is about the rest of the closure.
      expect(harness.fixture.readChapter(ORIGIN)).toContain('аннулирован');
    } finally {
      await harness.close();
    }
  });
});
