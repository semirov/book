/**
 * T2 (ADR-038 §14, BOOK-62) — the engine refuses a close or a verdict whose declared model is
 * missing or is not the pipeline's.
 *
 * The two codes are the whole AC1 mechanism: `MODEL_REQUIRED` when nothing is declared,
 * `MODEL_NOT_PIPELINE` when something else is. They are raised **first**, before the lease is
 * opened, so a refused close consumes nothing and the step stays exactly as it was. No provider
 * is called: the scripted session records the pinned string because the engine accepts no other.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { PIPELINE_MODEL, createEngineFixture, runStubStep } from './helpers.ts';

const FLASH = 'deepseek/deepseek-flash';
const TOKEN = 'test-token';

type Fixture = ReturnType<typeof createEngineFixture>;

/**
 * A change step driven to `land` (and, unless `gates` is false, through both verdicts) — the
 * shape a real pass leaves behind, so a close has nothing to refuse but the model.
 */
function landedPass(fixture: Fixture, options: { gates?: boolean } = {}): WriterAssignment {
  // The base the change is admitted against: a chapter with its own paragraph, not the frozen
  // basis sentence — the engine refuses a world-fact on an unread slot.
  fixture.writeChapterBlocks(1, 'Начало', ['Тестовый абзац.']);
  fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Изменённый абзац.', 'Второй абзац.']);
  fixture.engine.land(assignment.leaseId);
  if (options.gates === false) return assignment;
  for (const role of ['editor', 'consultant'] as const) {
    const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment;
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
  return assignment;
}

function stepRow(fixture: Fixture, stepId: string): { outcome: string | null; model: string | null } {
  return fixture.db.prepare('SELECT outcome, model FROM steps WHERE step_id = ?').get(stepId) as {
    outcome: string | null;
    model: string | null;
  };
}

describe('T2 — a prose step declares the pipeline model', () => {
  it('refuses done without a model and leaves the step open (nothing is consumed)', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landedPass(fixture);
      // The type, not only the runtime: a close that omits the model does not compile.
      // @ts-expect-error — `model` is required in `DoneOptions` (ADR-038).
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [] })).toThrow(/must declare --model/u);
      for (const declared of ['', '   ']) {
        expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: declared })).toThrow(
          /must declare --model/u,
        );
      }
      expect(stepRow(fixture, assignment.stepId)).toEqual({ outcome: null, model: null });
      // The lease was never touched: the same writer can still close the step.
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL })).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('refuses a close that declares another model, and names the expected one', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landedPass(fixture);
      let refusal: { code?: string; status?: number; detail?: unknown } | null = null;
      try {
        fixture.engine.done(assignment.leaseId, { seams: [], model: FLASH });
      } catch (error) {
        refusal = error as { code?: string; status?: number; detail?: unknown };
      }
      expect(refusal).toMatchObject({ code: 'MODEL_NOT_PIPELINE', status: 422 });
      expect(refusal?.detail).toEqual({ declared: FLASH, expected: PIPELINE_MODEL, where: 'done' });
      expect(stepRow(fixture, assignment.stepId).outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('refuses a verdict on both roles for both refusals, before the dispatch is consumed', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landedPass(fixture, { gates: false });
      for (const role of ['editor', 'consultant'] as const) {
        const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment;
        expect(gate.stepId).toBe(assignment.stepId);
        const answer = (model: string) =>
          fixture.engine.verdict(gate.stepId, {
            role,
            session: gate.session,
            verdict: 'HOLDS',
            findings: [],
            model,
            tokensIn: 1,
            tokensOut: 1,
          });
        const verdicts = () =>
          (fixture.db.prepare('SELECT COUNT(*) AS n FROM gate_verdicts').get() as { n: number }).n;
        const before = verdicts();
        expect(() => answer('')).toThrow(/must declare --model/u);
        let refusal: { code?: string; detail?: unknown } | null = null;
        try {
          answer(FLASH);
        } catch (error) {
          refusal = error as { code?: string; detail?: unknown };
        }
        expect(refusal).toMatchObject({ code: 'MODEL_NOT_PIPELINE' });
        expect(refusal?.detail).toMatchObject({ expected: PIPELINE_MODEL, where: 'verdict', declared: FLASH });
        // Nothing was recorded: a refused verdict leaves no row behind.
        expect(verdicts()).toBe(before);
        // The dispatch survived the refusal: the same session can still answer.
        answer(PIPELINE_MODEL);
      }
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM gate_verdicts').get()).toEqual({ n: 2 });
    } finally {
      fixture.close();
    }
  });

  it('applies the same rule to `seen`, which closes a prose step too', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landedPass(fixture);
      expect(() => fixture.engine.seen(assignment.leaseId, 'read', { model: '' })).toThrow(/must declare --model/u);
      const closed = fixture.engine.seen(assignment.leaseId, 'read, nothing to change', {
        model: PIPELINE_MODEL,
        tokensIn: 7,
        tokensOut: 3,
      });
      expect(closed.stepId).toBe(assignment.stepId);
      expect(stepRow(fixture, assignment.stepId).model).toBe(PIPELINE_MODEL);
      const tokens = fixture.db.prepare('SELECT tokens_in FROM steps WHERE step_id = ?').get(assignment.stepId) as {
        tokens_in: number;
      };
      // Exact: the step's own 7 plus both gates' 10 each (`landedPass`). A half-forwarded token
      // payload lands anywhere else, so `>=` would hide it (review, nit 9).
      expect(tokens.tokens_in).toBe(7 + 10 + 10);
    } finally {
      fixture.close();
    }
  });

  it('keeps escalate model-less on purpose: it claims no text was produced', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
      fixture.engine.start(assignment.leaseId);
      const escalated = fixture.engine.escalate(assignment.leaseId, 'budget: нет бюджета на пасс');
      expect(escalated.outcome).toBe('escalated');
      expect(stepRow(fixture, assignment.stepId).model).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('leaves the pinned model on a full stub pass: the step and both gates carry it', () => {
    const fixture = createEngineFixture();
    try {
      const run = runStubStep(fixture, { title: 'Глава', blocks: ['Тестовый абзац.'] });
      expect(run).not.toBeNull();
      expect(stepRow(fixture, run?.stepId ?? '').model).toBe(PIPELINE_MODEL);
      const gates = fixture.db
        .prepare('SELECT role, model FROM gate_verdicts ORDER BY role')
        .all() as Array<{ role: string; model: string }>;
      expect(gates.map((row) => row.role)).toEqual(['consultant', 'editor']);
      expect(gates.every((row) => row.model === PIPELINE_MODEL)).toBe(true);
    } finally {
      fixture.close();
    }
  });
});

describe('T2 — the internal API refuses with the same codes', () => {
  it('answers 422 MODEL_REQUIRED / MODEL_NOT_PIPELINE on done, and reports the pipeline model', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const health = await app.inject({ method: 'GET', url: '/internal/health', headers: auth });
      expect(health.json()).toMatchObject({
        state: { pipeline: { provider: fixture.config.pipeline.provider, model: PIPELINE_MODEL } },
      });

      // An empty body is a shape refusal (there is no `leaseId` to close) — the ADR's `{}`
      // shorthand made explicit: the model rule speaks about a close that names its step.
      const empty = await app.inject({ method: 'POST', url: '/internal/done', headers: auth, payload: {} });
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toMatchObject({ code: 'INVALID' });

      const assignment = landedPass(fixture);
      const missing = await app.inject({
        method: 'POST',
        url: '/internal/done',
        headers: auth,
        payload: { leaseId: assignment.leaseId, seams: [] },
      });
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({ code: 'MODEL_REQUIRED', detail: { where: 'done' } });

      const wrong = await app.inject({
        method: 'POST',
        url: '/internal/done',
        headers: auth,
        payload: { leaseId: assignment.leaseId, seams: [], model: FLASH },
      });
      expect(wrong.statusCode).toBe(422);
      expect(wrong.json()).toMatchObject({
        code: 'MODEL_NOT_PIPELINE',
        detail: { declared: FLASH, expected: PIPELINE_MODEL },
      });

      const ok = await app.inject({
        method: 'POST',
        url: '/internal/done',
        headers: auth,
        payload: { leaseId: assignment.leaseId, seams: [], model: PIPELINE_MODEL },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, data: { stepId: assignment.stepId } });
    } finally {
      await app.close();
      fixture.close();
    }
  });

  it('accepts the model on seen and forwards it to the step', async () => {
    const fixture = createEngineFixture();
    const app = await buildControl({ engine: fixture.engine, token: TOKEN, logger: false });
    const auth = { authorization: `Bearer ${TOKEN}` };
    try {
      const assignment = landedPass(fixture);
      const missing = await app.inject({
        method: 'POST',
        url: '/internal/seen',
        headers: auth,
        payload: { leaseId: assignment.leaseId, note: 'read' },
      });
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toMatchObject({ code: 'MODEL_REQUIRED', detail: { where: 'seen' } });

      const closed = await app.inject({
        method: 'POST',
        url: '/internal/seen',
        headers: auth,
        payload: { leaseId: assignment.leaseId, note: 'read', model: PIPELINE_MODEL },
      });
      expect(closed.statusCode).toBe(200);
      expect(stepRow(fixture, assignment.stepId).model).toBe(PIPELINE_MODEL);
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
