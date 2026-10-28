/**
 * BOOK-179 — the gate stopped lying about majors.
 *
 * ch01 came back with five major findings and the record printed «editor:HOLDS»: only a blocker
 * could stop a chapter, so a GAP with five majors was downgraded to HOLDS and the pass closed a
 * chapter the editor had just refused. The table is now: any blocker → stops; any major → GAP
 * that blocks the close; minors only → HOLDS with notes.
 */

import { describe, expect, it } from 'vitest';

import type { Finding, WriterAssignment } from '@book/shared';

import { PIPELINE_MODEL, createEngineFixture, submitRights } from './helpers.ts';

const MAJOR = (n: number): Finding => ({
  severity: 'major',
  location: `абзац ${String(n)}`,
  defect: 'образ объяснён второй раз, читателю не доверяют первый',
  fix: 'оставить одно объяснение',
}) as Finding;

const MINOR: Finding = {
  severity: 'minor',
  location: 'абзац 3',
  defect: 'ритм провисает',
  fix: 'сократить на строку',
} as Finding;

function landed(fixture: ReturnType<typeof createEngineFixture>, blocks: string[]): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'w1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', blocks);
  fixture.engine.land(assignment.leaseId);
  return assignment;
}

function answer(
  fixture: ReturnType<typeof createEngineFixture>,
  role: 'editor' | 'consultant',
  verdict: 'HOLDS' | 'GAP',
  findings: Finding[],
) {
  const gate = fixture.engine.next({ role, session: `${role}-1` }) as { stepId: string; session: string } | null;
  if (gate === null) throw new Error(`no ${role} assignment`);
  return fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict,
    findings,
    model: PIPELINE_MODEL,
    tokensIn: 10,
    tokensOut: 2,
  });
}

describe('the verdict a major earns', () => {
  it('keeps a five-major GAP a GAP, blocks the close and carries the findings', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, ['Первый абзац.', 'Второй абзац.']);
      const majors = [1, 2, 3, 4, 5].map(MAJOR);
      const recorded = answer(fixture, 'editor', 'GAP', majors);
      expect(recorded.verdict).toBe('GAP');
      expect(recorded.downgraded).toBe(false);
      answer(fixture, 'consultant', 'HOLDS', []);
      submitRights(fixture);
      // A major blocks `done` exactly as a blocker does — and the record keeps the list.
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL })).toThrow(
        /BLOCKER_UNRESOLVED|major/u,
      );
    } finally {
      fixture.close();
    }
  });

  it('downgrades a minors-only GAP to HOLDS with its notes', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = landed(fixture, ['Первый абзац.', 'Второй абзац.']);
      const recorded = answer(fixture, 'editor', 'GAP', [MINOR]);
      expect(recorded).toMatchObject({ verdict: 'HOLDS', downgraded: true });
      answer(fixture, 'consultant', 'HOLDS', []);
      submitRights(fixture);
      expect(() => fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL })).not.toThrow();
    } finally {
      fixture.close();
    }
  });
});
