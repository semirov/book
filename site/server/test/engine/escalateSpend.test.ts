/**
 * A parked pass carries what it spent (BOOK-117, ADR-038 §2).
 *
 * ADR-038 §2 exempts an escalation from the model *requirement*, not from the ledger: a pass that
 * parked after the model ran burned tokens, and a bound that cannot see them is exactly the bound
 * that must never exist. The measured pass here is the first real one — 10 422 characters of
 * prompt in, 18 561 tokens out — parked before its revision.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_BUDGET_CAPS, budgetSnapshot } from '../../src/budget.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { appendStage } from '../../src/stages/repo.ts';
import { createEngineFixture, type Fixture } from './helpers.ts';

const CAPS = DEFAULT_BUDGET_CAPS;
const PINNED = 'deepseek/deepseek-v4-pro';

/** One model call as the writer records it: the stage row is the database's own knowledge. */
function drafting(fixture: Fixture, passId: string, tokensIn: number, tokensOut: number, at: number): void {
  appendStage(fixture.db, {
    chapter: 5,
    passId,
    stage: 'drafting',
    at,
    actor: { process: 'writer', model: PINNED },
    summary: `черновик: ${String(tokensIn)} / ${String(tokensOut)}`,
    tokens: { in: tokensIn, out: tokensOut },
  });
}

/** One pass of chapter 5, parked with whatever the caller knows about its model calls. */
function parkedPass(fixture: Fixture, spend?: { model: string; tokensIn: number; tokensOut: number }): string {
  const assignment = fixture.engine.openChapterPass(5, 'writer-park') as WriterAssignment | null;
  if (!assignment) throw new Error('expected a pass');
  fixture.engine.start(assignment.leaseId);
  fixture.engine.escalate(assignment.leaseId, 'лимит токенов на проход исчерпан', spend);
  return assignment.stepId;
}

describe('escalate — an escalation carries what it spent', () => {
  it('closes the step with the reported usage and prices the parked pass', () => {
    const fixture = createEngineFixture();
    try {
      expect(budgetSnapshot(fixture.db, CAPS, fixture.clock.now()).day.spentUsd).toBe(0);
      const stepId = parkedPass(fixture, { model: PINNED, tokensIn: 10_422, tokensOut: 18_561 });

      // The step is the record: the same triple `done` writes, and the same public outcome.
      expect(fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId)).toMatchObject({
        outcome: 'escalated',
        model: PINNED,
        tokens_in: 10_422,
        tokens_out: 18_561,
      });

      // The ledger row a park used to leave at 0/0 — now the real numbers, priced at the pin's rate.
      const rows = fixture.db.prepare('SELECT * FROM pass_spend').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pass_id: stepId,
        pass: 'draft',
        chapter: 5,
        model: PINNED,
        tokens_in: 10_422,
        tokens_out: 18_561,
        priced: 1,
      });
      // (10 422 × 0.66 + 18 561 × 1.98) / 1 000 000, the pipeline's own arithmetic.
      expect(rows[0]?.usd).toBe(0.043629);

      // The day's sum moves with the park: the money bound sees the pass it stopped.
      const dto = budgetSnapshot(fixture.db, CAPS, fixture.clock.now());
      expect(dto.day.spentUsd).toBe(0.043629);
      expect(dto.book.spentUsd).toBe(0.043629);
      expect(dto.tokens.today).toBe(28_983);
    } finally {
      fixture.close();
    }
  });

  it('keeps an escalation that claims no text at model null, zero tokens and priced 0 (BOOK-23)', () => {
    const fixture = createEngineFixture();
    try {
      const stepId = parkedPass(fixture);

      expect(fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId)).toMatchObject({
        outcome: 'escalated',
        model: null,
        tokens_in: 0,
        tokens_out: 0,
      });
      // No model ran, so no price is invented: the row exists, its money is not a measurement.
      const row = fixture.db.prepare('SELECT * FROM pass_spend').get() as Record<string, unknown>;
      expect(row).toMatchObject({ pass_id: stepId, model: null, usd: 0, priced: 0 });
      const dto = budgetSnapshot(fixture.db, CAPS, fixture.clock.now());
      expect(dto.day.spentUsd).toBe(0);
      expect(dto.tokens.today).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('a step closed by the reaper says what its stages spent, priced at their model', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.openChapterPass(5, 'writer-reaped') as WriterAssignment | null;
      if (!assignment) throw new Error('expected a pass');
      fixture.engine.start(assignment.leaseId);
      // The writer made two calls and never came back: only the stage rows know what they cost.
      drafting(fixture, assignment.stepId, 3_000, 500, fixture.clock.now());
      drafting(fixture, assignment.stepId, 1_000, 200, fixture.clock.now() + 1_000);

      fixture.clock.advance(fixture.config.stepWallMs + 60_000);
      expect(fixture.engine.reap().stepWalls).toEqual([assignment.stepId]);

      // The reaper reports no model and no tokens; the database's best knowledge is the step's.
      expect(fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(assignment.stepId)).toMatchObject({
        outcome: 'escalated',
        model: PINNED,
        tokens_in: 4_000,
        tokens_out: 700,
      });
      const row = fixture.db.prepare('SELECT * FROM pass_spend').get() as Record<string, unknown>;
      expect(row).toMatchObject({ pass_id: assignment.stepId, model: PINNED, tokens_in: 4_000, tokens_out: 700, priced: 1 });
      // (4 000 × 0.66 + 700 × 1.98) / 1 000 000 — a chapter that was written does not read as free.
      expect(row.usd).toBe(0.004026);
      expect(budgetSnapshot(fixture.db, CAPS, fixture.clock.now()).day.spentUsd).toBe(0.004026);
    } finally {
      fixture.close();
    }
  });

  it('keeps the larger number when the close reports more than the stages recorded', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.openChapterPass(5, 'writer-late') as WriterAssignment | null;
      if (!assignment) throw new Error('expected a pass');
      fixture.engine.start(assignment.leaseId);
      drafting(fixture, assignment.stepId, 1_000, 100, fixture.clock.now());

      fixture.engine.escalate(assignment.leaseId, 'не беру', { model: PINNED, tokensIn: 5_000, tokensOut: 900 });
      expect(fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(assignment.stepId)).toMatchObject({
        model: PINNED,
        tokens_in: 5_000,
        tokens_out: 900,
      });
    } finally {
      fixture.close();
    }
  });

  it('adds both gate verdicts to the writer’s own report, once', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.openChapterPass(5, 'writer-gates') as WriterAssignment | null;
      if (!assignment) throw new Error('expected a pass');
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(5, 'Глава пять', ['Первый абзац.', 'Второй абзац.']);
      fixture.engine.land(assignment.leaseId);
      drafting(fixture, assignment.stepId, 1_000, 200, fixture.clock.now());
      for (const role of ['editor', 'consultant'] as const) {
        const gate = fixture.engine.next({ role, session: `${role}-spend` }) as GateAssignment | null;
        if (!gate) throw new Error(`no ${role} assignment`);
        fixture.engine.verdict(gate.stepId, {
          role,
          session: gate.session,
          verdict: 'HOLDS',
          findings: [],
          model: 'deepseek/deepseek-v4-pro',
          tokensIn: 100,
          tokensOut: 10,
        });
      }

      // The protocol: a close reports the writer's own 1 000 (the stage row agrees), and both gate
      // rows — 200 together — are added once by the close.
      fixture.engine.escalate(assignment.leaseId, 'гейт не ответил', {
        model: PINNED,
        tokensIn: 1_000,
        tokensOut: 200,
      });
      expect(fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(assignment.stepId)).toMatchObject({
        model: PINNED,
        tokens_in: 1_200,
        tokens_out: 220,
      });
    } finally {
      fixture.close();
    }
  });
});
