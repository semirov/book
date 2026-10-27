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
import { createEngineFixture, type Fixture } from './helpers.ts';

const CAPS = DEFAULT_BUDGET_CAPS;
const PINNED = 'deepseek/deepseek-v4-pro';

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
});
