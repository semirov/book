/**
 * BOOK-117 (owner, 2026-10-28) — a repair is not the pipeline's pass.
 *
 * ADR-038 refuses a close that names anything but the pinned model, because «prod is Pro» must
 * be checkable for the *lane*. A person repairing the book may run another model, and then the
 * honest record is that model plus `provenance: operator` — never an invented `pro` label, and
 * never a step that can only ever escalate. The two directions are pinned here: an operator
 * close with flash succeeds and records flash; a lane close with flash is still refused.
 */

import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { PIPELINE_MODEL, createEngineFixture, submitRights } from './helpers.ts';

const FLASH = 'deepseek/deepseek-flash';

/** One draft pass on ch01, landed, with both prose gates answered. */
function landed(fixture: ReturnType<typeof createEngineFixture>, session: string): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Глава', ['Первый абзац главы.', 'Второй абзац главы.']);
  fixture.engine.land(assignment.leaseId);
  for (const role of ['editor', 'consultant'] as const) {
    const gate = fixture.engine.next({ role, session: `${role}-${session}` }) as { stepId: string; session: string } | null;
    if (gate === null) throw new Error(`no ${role} assignment`);
    fixture.engine.verdict(gate.stepId, {
      role,
      session: gate.session,
      verdict: 'HOLDS',
      findings: [],
      model: PIPELINE_MODEL,
      tokensIn: 10,
      tokensOut: 2,
    });
  }
  submitRights(fixture);
  return assignment;
}

describe('a close names who answered', () => {
  it('a pipeline pass keeps the pinned model and is marked `pipeline`', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, 'lane-0');
      fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL, tokensIn: 500, tokensOut: 50 });
      const row = fixture.db
        .prepare('SELECT model, provenance FROM steps WHERE step_id = ?')
        .get(assignment.stepId) as { model: string; provenance: string };
      expect(row.model).toBe(PIPELINE_MODEL);
      expect(row.provenance).toBe('pipeline');
    } finally {
      fixture.close();
    }
  });

  it('refuses a lane close that names another model: the pin is not weakened', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, 'lane-1');
      expect(() =>
        fixture.engine.done(assignment.leaseId, {
          seams: [],
          model: FLASH,
          tokensIn: 10,
          tokensOut: 2,
        }),
      ).toThrow(/MODEL_NOT_PIPELINE|the pipeline runs on/u);
    } finally {
      fixture.close();
    }
  });

  it('an operator close is exempt: it records flash and provenance, never a relabelled pro', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, 'operator-2');
      const closed = fixture.engine.done(assignment.leaseId, {
        seams: [],
        model: FLASH,
        tokensIn: 900,
        tokensOut: 90,
        provenance: 'operator',
      });
      expect(closed.outcome).toBe('rewritten');
      const step = fixture.db
        .prepare('SELECT model, provenance, tokens_in FROM steps WHERE step_id = ?')
        .get(assignment.stepId) as { model: string; provenance: string; tokens_in: number };
      expect(step.model).toBe(FLASH);
      expect(step.provenance).toBe('operator');
      const spend = fixture.db
        .prepare('SELECT model, provenance FROM pass_spend WHERE pass_id = ?')
        .get(assignment.stepId) as { model: string; provenance: string };
      expect(spend.model).toBe(FLASH);
      expect(spend.provenance).toBe('operator');
    } finally {
      fixture.close();
    }
  });

  it('an estimated pipeline close keeps the pin, and the ledger names the estimate (BOOK-219)', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, 'lane-estimated');
      fixture.engine.done(assignment.leaseId, {
        seams: [],
        model: PIPELINE_MODEL,
        tokensIn: 25_300,
        tokensOut: 15_068,
        provenance: 'pipeline-estimated',
      });
      // The money's own record: priced, with the word that says how it was read — never `priced = 0`.
      const spend = fixture.db
        .prepare('SELECT priced, provenance, usd FROM pass_spend WHERE pass_id = ?')
        .get(assignment.stepId) as { priced: number; provenance: string; usd: number };
      expect(spend.provenance).toBe('pipeline-estimated');
      expect(spend.priced).toBe(1);
      expect(spend.usd).toBeGreaterThan(0);
      // The step answers *who ran the pass*: the pipeline did (`model.ts` `stepProvenance`).
      const step = fixture.db
        .prepare('SELECT provenance, model FROM steps WHERE step_id = ?')
        .get(assignment.stepId) as { provenance: string; model: string };
      expect(step).toEqual({ provenance: 'pipeline', model: PIPELINE_MODEL });
    } finally {
      fixture.close();
    }
  });

  it('refuses an estimated close that names another model: the estimate is not an exemption', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, 'lane-estimated-flash');
      expect(() =>
        fixture.engine.done(assignment.leaseId, {
          seams: [],
          model: FLASH,
          tokensIn: 10,
          tokensOut: 2,
          provenance: 'pipeline-estimated',
        }),
      ).toThrow(/MODEL_NOT_PIPELINE|the pipeline runs on/u);
    } finally {
      fixture.close();
    }
  });
});
