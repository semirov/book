/**
 * BOOK-173 §7 — the plan travels into a gate's envelope.
 *
 * The gate judges the landing against the closure the change stood on: `outcome`, `nodes`,
 * `edges`, `patches` and `bounds`. A change that says `ripple` and has no plan row is an
 * inconsistency (the row is written in the same transaction as the outcome), so a dispatch is
 * refused with `PLAN_MISSING` instead of a gate judging consequences against nothing.
 */

import { describe, expect, it } from 'vitest';

import type { GateAssignment } from '../../src/engine/gates.ts';
import * as store from '../../src/engine/store.ts';
import { storePlan, type RipplePlan } from '../../src/ledger/graph/plan.ts';
import { createEngineFixture } from './helpers.ts';
import { seedChapter } from '../ledger/helpers.ts';

/**
 * BOOK-173 §7 — the plan travels into the gate's envelope.
 *
 * The gate judges the landing against the closure the change stood on: `outcome`, `nodes`,
 * `edges`, `patches` and `bounds`. A change that says `ripple` and has no plan row is an
 * inconsistency (the row is written in the same transaction as the outcome), so a dispatch is
 * refused with `PLAN_MISSING` instead of a gate judging consequences against nothing.
 */
describe('the plan in a gate’s assignment (BOOK-173 §7)', () => {
  const AT = '2026-10-28T12:00:00Z';

  function planOf(changeId: string): RipplePlan {
    return {
      changeId,
      chapter: 5,
      outcome: 'ripple',
      proven: true,
      seeds: [],
      nodes: [{ chapter: 12, mandatory: true, factId: 'f:one' } as never],
      edges: ['edg_one'],
      edgeDetail: [],
      patches: [{ chapter: 12, edits: 1 } as never],
      closureSize: { nodes: 1, edges: 1, chapters: 2, parts: 1 },
      chaptersTouched: [5, 12],
      bounds: { chars: 4_000, usd: 0.6, iterations: 4, nodes: 1_500, edges: 3_000 },
      unresolved: [],
      truncated: false,
    };
  }

  /** A `change` step that landed text, its change closed as a ripple, and its lease. */
  function landedRipple(fixture: ReturnType<typeof createEngineFixture>, withPlan: boolean): void {
    seedChapter(fixture.db, { chapter: 5, texts: ['Допуск выдан, и смена стоит.'], at: AT });
    fixture.db
      .prepare(
        `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint,
                              status, enqueued_at, outcome)
         VALUES ('chg_plan', 'operator', 5, 'в главе 5 документ', 1, 'sha', '[]', 'phrase', 'done', ?, 'ripple')`,
      )
      .run(AT);
    store.insertStep(fixture.db, {
      stepId: 'stp_plan',
      cascadeId: null,
      seq: 0,
      wave: 0,
      lane: 'forward',
      pass: 'change',
      chapter: 5,
      boundary: '5',
      seamsIn: '[]',
      revBefore: 1,
      at: AT,
    });
    store.updateStep(fixture.db, 'stp_plan', {
      landed_at: AT,
      landed_sha: 'a'.repeat(64),
      blocks_touched: 1,
    });
    fixture.db
      .prepare(
        `INSERT INTO leases (id, step_id, change_id, lane, chapter, is_front, kind, session,
                             expected_rev, acquired_at, heartbeat_at, expires_at)
         VALUES ('lea_plan', 'stp_plan', 'chg_plan', 'forward', 5, 0, 'change', 'writer-1', 1, ?, ?, ?)`,
      )
      .run(AT, AT, AT);
    if (withPlan) storePlan(fixture.db, planOf('chg_plan'), AT, { mode: 'patch' });
  }

  it('carries all five fields of the plan, and only those', () => {
    const fixture = createEngineFixture();
    try {
      landedRipple(fixture, true);
      const gate = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      expect(Object.keys(gate.plan ?? {}).sort()).toEqual(['bounds', 'edges', 'nodes', 'outcome', 'patches']);
      expect(gate.plan).toMatchObject({
        outcome: 'ripple',
        nodes: [{ chapter: 12, mandatory: true }],
        edges: ['edg_one'],
        patches: [{ chapter: 12, edits: 1 }],
        bounds: { chars: 4_000, usd: 0.6, iterations: 4 },
      });
    } finally {
      fixture.close();
    }
  });

  it('refuses the dispatch with PLAN_MISSING when a ripple has no plan row', () => {
    const fixture = createEngineFixture();
    try {
      landedRipple(fixture, false);
      expect(() => fixture.engine.next({ role: 'editor', session: 'editor-1' })).toThrow(/no plan/u);
      // Nothing was dispatched: the gate table is still empty.
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM gate_dispatches').get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });
});
