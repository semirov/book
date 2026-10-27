import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { insertRevision } from '../../src/db/repo/revisions.ts';
import { assertEndingFreeze } from '../../src/engine/freeze.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, runStubStep } from './helpers.ts';

function seedCascadeRevisionOfTheEnding(fixture: ReturnType<typeof createEngineFixture>): void {
  fixture.db
    .prepare(
      `INSERT INTO chapters (n, rev, title, sha256, chars, block_count, written_at, updated_at)
       VALUES (67, 1, 'Конец', 'sha-67', 100, 1, '2026-10-25T09:00:00Z', '2026-10-25T09:00:00Z')`,
    )
    .run();
  insertRevision(fixture.db, {
    chapter: 67,
    rev: 2,
    at: '2026-10-25T09:30:00Z',
    kind: 'rewrite',
    causeKind: 'cascade',
    changeId: null,
    cascadeId: null,
    stepId: null,
    added: 0,
    changed: 1,
    removed: 0,
    snapshot: 'versions/ch67/sha-67.md',
    attributed: true,
    logNote: null,
  });
}

describe('F025 — the ending is frozen (§6C.4, ADR-024)', () => {
  it('passes on a book whose ending was never rewritten by a ripple', () => {
    const fixture = createEngineFixture();
    try {
      expect(() => assertEndingFreeze(fixture.db)).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('refuses to close a step on top of a cascade revision of chapter 67', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-fwd' }) as WriterAssignment | null;
      if (assignment === null) throw new Error('the forward lane offered no draft');
      fixture.engine.start(assignment.leaseId);
      fixture.writeChapterBlocks(1, 'Тестовая глава', ['Тестовый абзац.']);
      fixture.engine.land(assignment.leaseId);

      seedCascadeRevisionOfTheEnding(fixture);

      expect(() => assertEndingFreeze(fixture.db)).toThrowError(/конец фиксирован/u);

      // Both gates answer, so the refusal that follows is F025, not a missing verdict.
      for (const role of ['editor', 'consultant'] as const) {
        const gate = fixture.engine.next({ role, session: `${role}-stub` }) as { stepId: string; session: string } | null;
        if (gate === null) throw new Error(`no ${role} assignment`);
        fixture.engine.verdict(gate.stepId, {
          role,
          session: gate.session,
          verdict: 'HOLDS',
          findings: [],
          model: PIPELINE_MODEL,
          tokensIn: 120,
          tokensOut: 12,
        });
      }
      expect(() =>
        fixture.engine.done(assignment.leaseId, { seams: [], note: 'scripted session', model: PIPELINE_MODEL }),
      ).toThrowError(/F025|конец фиксирован/u);
      // The step is still open: a refused close writes nothing.
      const step = fixture.db
        .prepare('SELECT outcome FROM steps WHERE step_id = ?')
        .get(assignment.stepId) as { outcome: string | null };
      expect(step.outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('evaluates the ending instead of rewriting it when a ripple reaches chapter 67', () => {
    const fixture = createEngineFixture({
      chapters: {
        65: chapterText('Глава 65', ['Служебный текст для проверки, он не является текстом книги.']),
        66: chapterText('Глава 66', ['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.']),
        67: chapterText('Глава 67', ['Служебный текст для проверки.']),
      },
    });
    try {
      fixture.engine.enqueue({
        kind: 'operator',
        chapter: 66,
        intent: 'абзац должен измениться к утру',
      });

      const origin = runStubStep(
        fixture,
        {
          title: 'Глава 66',
          blocks: ['Тестовый абзац номер один. Это служебный текст, он не является текстом книги.', 'Изменённый абзац.'],
          seams: [{ boundary: 67, reason: 'следующая глава начинается с того же утра' }],
        },
        'fwd',
      );
      expect(origin?.assignment.pass).toBe('change');

      // The ripple walks down to 65 and then evaluates the ending. It never writes ch67.
      const down = runStubStep(
        fixture,
        {
          title: 'Глава 65',
          blocks: ['Служебный текст для проверки, он не является текстом книги.', 'Изменённый абзац.'],
          seams: [],
        },
        'bwd',
      );
      expect(down?.assignment.pass).toBe('cascade');
      expect(down?.assignment.chapter).toBe(65);

      const ending = runStubStep(fixture, { seams: [] });
      expect(ending?.assignment.pass).toBe('ending');
      expect(ending?.assignment.chapter).toBe(67);
      // The ending step is evaluated, not written: its file is already final.
      expect(ending?.revisions).toBe(0);

      const endingStep = fixture.db
        .prepare(`SELECT pass, chapter, outcome FROM steps WHERE step_id = ?`)
        .get(ending?.stepId ?? '') as { pass: string; chapter: number | null; outcome: string | null };
      expect(endingStep).toMatchObject({ pass: 'ending', chapter: 67, outcome: 'evaluated' });

      // F025, the assertion itself: no revision of chapter 67 came from a cascade.
      const cascadeRevisions = fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM revisions WHERE chapter = 67 AND cause_kind = 'cascade'`)
        .get() as { n: number };
      expect(cascadeRevisions.n).toBe(0);
      const cascadeStepsOnTheEnding = fixture.db
        .prepare(`SELECT COUNT(*) AS n FROM steps WHERE chapter = 67 AND pass = 'cascade'`)
        .get() as { n: number };
      expect(cascadeStepsOnTheEnding.n).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
