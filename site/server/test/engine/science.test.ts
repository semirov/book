import type { Finding, WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { closeReason } from '../../src/engine/cascade.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { readUnresolved } from '../../src/engineState/reader.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, runStubStep } from './helpers.ts';

/**
 * BOOK-76 / BOOK-DOC-52 §4 — «a physics claim that fails the pass never lands».
 *
 * The stub consultant answers `GAP` with a blocker on every revision. Past the cycle cap the
 * step is stopped, never published, the ripple closes `escalated:science`, nothing further
 * opens, and the change is refused (`void · dropped`) with the physics stop's own alert. Below the
 * cap the same verdict refuses a close (`BLOCKER_UNRESOLVED`) instead of letting the writer
 * walk away from it. The mirror (an editor blocker still publishing with its finding) is
 * today's case in `gates.test.ts`.
 */

const blocker = (defect = 'the light arrives before it could have'): Finding[] => [
  { severity: 'blocker', location: 'глава 7, абзац 2', defect, fix: 'give the signal a carrier and a delay' },
];

function draftOnce(fixture: ReturnType<typeof createEngineFixture>): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Тестовый абзац.', 'Это служебный текст.']);
  fixture.engine.land(assignment.leaseId);
  return assignment;
}

function answer(
  fixture: ReturnType<typeof createEngineFixture>,
  role: 'editor' | 'consultant',
  verdict: 'HOLDS' | 'GAP',
  findings: Finding[] = [],
) {
  const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment;
  return fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict,
    findings,
    model: PIPELINE_MODEL,
    tokensIn: 100,
    tokensOut: 10,
  });
}

describe('a physics claim that fails the pass never lands (BOOK-76)', () => {
  it('stops the step and the ripple, and publishes nothing with a finding', () => {
    const fixture = createEngineFixture({
      chapters: {
        5: chapterText('Перед', ['Служебная строка.']),
        6: chapterText('Середина', ['Тестовый абзац.']),
        7: chapterText('После', ['Тестовый абзац номер два. Это служебный текст, он не является текстом книги.']),
      },
    });
    try {
      const before: Record<number, string | null> = {
        5: fixture.readChapter(5),
        6: fixture.readChapter(6),
        7: fixture.readChapter(7),
      };
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 6, intent: 'убрать абзац' });
      const origin = runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац.'],
        seams: [{ boundary: 7, reason: 'соседняя глава продолжает сцену' }],
      });
      expect(origin?.result.cascadeId).toBeTruthy();

      // The downward wing first: chapter 5 holds, so the ripple turns upward.
      const down = runStubStep(fixture, { title: 'Перед', blocks: ['Служебная строка.'], seams: [] }, 'bwd');
      expect(down?.assignment.chapter).toBe(5);

      // Five revisions are allowed (§10.8); the sixth blocker stops the step instead of publishing.
      const repair = runStubStep(fixture, {
        title: 'После',
        blocks: ['Тестовый абзац номер два. Это служебный текст, он не является текстом книги.'],
        seams: [],
        consultant: { verdict: 'GAP', findings: blocker() },
      });
      expect(repair?.assignment.chapter).toBe(7);
      expect(repair?.revisions).toBe(5);
      expect(repair?.result.outcome).toBe('escalated');

      const trace = fixture.engine.trace(change.id);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      const cascade = trace.change.cascade;
      if (!cascade) throw new Error('expected a cascade trace');

      // (i) the failing step closed escalated, with the consultant's GAP on record…
      const repairStep = cascade.steps.find((step) => step.step.pass === 'cascade' && step.step.chapter === 7);
      expect(repairStep?.step.outcome).toBe('escalated');
      expect(repairStep?.gates.find((gate) => gate.role === 'consultant')?.verdict).toBe('GAP');

      // (ii) …and no step of the change was published with a finding.
      expect(cascade.steps.map((step) => step.step.outcome)).not.toContain('published_with_finding');

      // (iii) the ripple closed on the physics pass, and the change opened no further step.
      expect(cascade.outcome).toBe('escalated:science');
      expect(cascade.status).toBe('escalated');
      expect(cascade.steps).toHaveLength(3);
      expect(cascade.steps.every((step) => step.step.outcome !== null)).toBe(true);

      // (iv) the change is refused with the physics stop's own words and alert. BOOK-218 owns
      // the sentence (`CLOSE_COPY.science`), BOOK-219 owns the sink: no `escalated` change.
      expect(trace.change.change.status).toBe('void');
      expect(trace.change.change.outcome).toBe('dropped');
      expect(trace.change.change.reason).toBe(closeReason('science'));
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('science');

      // Every chapter the refused ripple wrote is back to its pre-pass revision: a refusal
      // means no text of the change stands.
      for (const chapter of [5, 6, 7]) {
        expect(fixture.readChapter(chapter)).toBe(before[chapter]);
      }
      // The state overlay still names the seam: the cascade carries its own stop vocabulary.
      expect(readUnresolved(fixture.db).map((entry) => entry.changeId)).toContain(change.id);
    } finally {
      fixture.close();
    }
  });

  it('gives the physics stop precedence when both gates block at the cap', () => {
    const fixture = createEngineFixture({
      chapters: {
        5: chapterText('Перед', ['Служебная строка.']),
        6: chapterText('Середина', ['Тестовый абзац.']),
        7: chapterText('После', ['Тестовый абзац номер два. Это служебный текст, он не является текстом книги.']),
      },
    });
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 6, intent: 'убрать абзац' });
      runStubStep(fixture, {
        title: 'Середина',
        blocks: ['Тестовый абзац.'],
        seams: [{ boundary: 7, reason: 'соседняя глава продолжает сцену' }],
      });
      runStubStep(fixture, { title: 'Перед', blocks: ['Служебная строка.'], seams: [] }, 'bwd');

      const repair = runStubStep(fixture, {
        title: 'После',
        blocks: ['Тестовый абзац номер два. Это служебный текст, он не является текстом книги.'],
        seams: [],
        editor: { verdict: 'GAP', findings: blocker('the neighbour still mentions the rug') },
        consultant: { verdict: 'GAP', findings: blocker() },
      });
      expect(repair?.result.outcome).toBe('escalated');

      const trace = fixture.engine.trace(change.id);
      if (trace?.kind !== 'change') throw new Error('expected a change trace');
      const cascade = trace.change.cascade;
      if (!cascade) throw new Error('expected a cascade trace');
      // The prose finding is published only when the physics pass holds; here it does not, so
      // the ripple stops on the physics word and no step carries `published_with_finding`.
      expect(cascade.outcome).toBe('escalated:science');
      expect(trace.change.change.status).toBe('void');
      expect(trace.change.change.outcome).toBe('dropped');
      expect(cascade.steps.map((step) => step.step.outcome)).not.toContain('published_with_finding');
    } finally {
      fixture.close();
    }
  });
});

describe('a blocking physics verdict cannot be closed away (BOOK-76)', () => {
  it('refuses done below the cap, and lets the session escalate instead', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftOnce(fixture);
      answer(fixture, 'editor', 'HOLDS');
      expect(answer(fixture, 'consultant', 'GAP', blocker()).action).toBe('revise');

      // The writer does not re-land: the blocking verdict is still on the row, below the cap.
      let refusal: { code?: string; status?: number; message?: string } | null = null;
      try {
        fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
      } catch (error) {
        refusal = error as { code?: string; status?: number; message?: string };
      }
      expect(refusal).toMatchObject({ code: 'BLOCKER_UNRESOLVED', status: 409 });
      expect(refusal?.message).toMatch(/revise it and land again, or escalate/u);

      // The exit exists: an escalation is accepted, so the guard is not a dead end.
      const escalated = fixture.engine.escalate(assignment.leaseId, 'физика: сигнал без носителя');
      expect(escalated.outcome).toBe('escalated');
    } finally {
      fixture.close();
    }
  });
});
