/**
 * BOOK-117 — re-opening a landed, escalated step so the gates it now satisfies can close it
 * (the owner's rule of 2026-10-28: the chapter stays where it is, the step closes with the
 * verdicts it earned).
 *
 * Narrow on purpose: only `escalated`, only landed, and only while the chapter is still the
 * text the step landed — a step whose text moved has nothing left to close.
 */

import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { createEngineFixture } from './helpers.ts';

/** One draft pass on ch01: the writer lands its text, and nothing else has happened yet. */
function draftChapter(fixture: ReturnType<typeof createEngineFixture>, blocks: string[]): WriterAssignment {
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', blocks);
  return assignment;
}

function attempts(fixture: ReturnType<typeof createEngineFixture>, changeId: string): number {
  return (fixture.db.prepare('SELECT attempts FROM changes WHERE id = ?').get(changeId) as { attempts: number }).attempts;
}

function stepRow(fixture: ReturnType<typeof createEngineFixture>, stepId: string): Record<string, unknown> | undefined {
  return fixture.db.prepare('SELECT * FROM steps WHERE step_id = ?').get(stepId) as Record<string, unknown> | undefined;
}

describe('reopen — an escalated, landed step', () => {
  it('re-opens the step, keeps the text and offers the gates again', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, ['Тестовый абзац главы.', 'Второй абзац.']);
      fixture.engine.land(assignment.leaseId);
      fixture.engine.escalate(assignment.leaseId, 'гейт прав не ответил');

      const opened = fixture.engine.reopen(assignment.stepId, 'BOOK-61: Gate B теперь есть');
      expect(opened).toEqual({ stepId: assignment.stepId, reopened: true });
      const step = stepRow(fixture, assignment.stepId) as Record<string, unknown>;
      expect(step.outcome).toBeNull();
      expect(step.closed_at).toBeNull();
      // The landed text is untouched: the step closes the chapter it wrote.
      expect(step.landed_at).not.toBeNull();
      // The gates are offered again, and the editor comes first.
      const editor = fixture.engine.next({ role: 'editor', session: 'editor-again' });
      expect(editor).not.toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('resets the attempt counter, so the reaper does not escalate the fresh window on the next tick', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, ['Тестовый абзац главы.', 'Второй абзац.']);
      fixture.engine.land(assignment.leaseId);
      fixture.engine.escalate(assignment.leaseId, 'гейт прав не ответил');
      // A repair pass always belongs to a change; three expired leases put it at the reaper's
      // limit, and a reopen is a fresh window, not the fourth attempt of the closed one.
      fixture.db
        .prepare(
          `INSERT INTO changes (id, kind, chapter, intent, base_rev, base_sha256, base_blocks, scope_hint, status, enqueued_at, attempts)
           VALUES ('chg_reopen_fix', 'operator', 1, 'починить главу', 0, '', '[]', 'chapter', 'pending', '2026-10-28T00:00:00Z', 3)`,
        )
        .run();
      fixture.db.prepare('UPDATE leases SET change_id = ? WHERE step_id = ?').run('chg_reopen_fix', assignment.stepId);

      fixture.engine.reopen(assignment.stepId, 'BOOK-61: Gate B теперь есть');
      expect(attempts(fixture, 'chg_reopen_fix')).toBe(0);
      // And the next tick leaves the step open for the gates instead of escalating it again.
      const report = fixture.engine.reap();
      expect(report.gateTimeouts).not.toContain(assignment.stepId);
      expect((stepRow(fixture, assignment.stepId) as { outcome: string | null }).outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('refuses a step that is not escalated, an unlanded one, and one whose text moved', () => {
    const fixture = createEngineFixture();
    try {
      const assignment = draftChapter(fixture, ['Тестовый абзац главы.']);
      // Open: nothing to reopen.
      expect(() => fixture.engine.reopen(assignment.stepId, 'нет')).toThrow(/not escalated/u);
      fixture.engine.land(assignment.leaseId);
      fixture.engine.escalate(assignment.leaseId, 'гейт прав не ответил');
      // The chapter moved after the close: the step no longer describes the text.
      fixture.writeChapterBlocks(assignment.chapter as number, 'Глава', ['Другой текст главы.', 'И ещё один.']);
      expect(() => fixture.engine.reopen(assignment.stepId, 'нет')).toThrow(/переоткрывать нечего/u);
    } finally {
      fixture.close();
    }
  });
});
