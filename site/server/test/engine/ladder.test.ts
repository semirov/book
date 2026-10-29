/**
 * BOOK-DOC-84 §10.8 — the ladder, on the engine's own rows.
 *
 * The third failure widens the requirements (`wider-edit`, a rewrite), attempts 4–5 run under
 * it, the fifth hands over to a desperate sixth with its own short bound, and the sixth's
 * failure is the close. A pass that succeeds at attempt 4 closes `closed` — the ladder is not a
 * countdown to a refusal.
 */

import { describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { chapterText, createEngineFixture, runStubStep } from './helpers.ts';

const BLOCK = 'Тестовый абзац номер один. Это служебный текст, он не является текстом книги.';

function started() {
  const fixture = createEngineFixture({
    chapters: { 1: chapterText('Начало', [BLOCK]) },
  });
  const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'убрать служебную строку' });
  const first = fixture.engine.next({ for: 'fwd', session: 'fwd-1' }) as WriterAssignment;
  return { fixture, change, first };
}

/** Fail one attempt: the session dies, the reaper expires the lease and re-issues. */
function failAttempt(
  fixture: ReturnType<typeof createEngineFixture>,
  attempt: number,
): WriterAssignment | null {
  fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
  fixture.engine.reap();
  if (attempt >= 6) return null;
  return fixture.engine.next({ for: 'fwd', session: `fwd-${String(attempt + 1)}` }) as WriterAssignment | null;
}

describe('§10.8 — five attempts, a widening at three, a desperate sixth', () => {
  it('widens after the third failure and hands attempt 4 the widened sentence', () => {
    const { fixture, change, first } = started();
    try {
      let assignment: WriterAssignment = first;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const next = failAttempt(fixture, attempt);
        if (next !== null) assignment = next;
      }
      const step = fixture.db.prepare('SELECT widened, mode FROM steps WHERE step_id = ?').get(first.stepId) as {
        widened: string | null;
        mode: string | null;
      };
      expect(step).toEqual({ widened: 'wider-edit', mode: 'rewrite' });
      // The fourth claim is the first one under the widened requirements.
      expect(assignment.attempt).toBe(4);
      expect(assignment.widened).toEqual({ code: 'wider-edit', sentence: 'правим шире: не строку, а абзац' });
      expect(assignment.desperate).toBe(false);
      expect(assignment.mode).toBe('rewrite');
      expect(assignment.maxAttempts).toBe(5);
      // §10.8's scope widening: the change is no longer a phrase but a chapter.
      expect(fixture.db.prepare('SELECT scope_hint FROM changes WHERE id = ?').get(change.id)).toEqual({
        scope_hint: 'chapter',
      });
    } finally {
      fixture.close();
    }
  });

  it('a pass that succeeds at attempt 4 closes `closed`', () => {
    const { fixture, first } = started();
    try {
      // Two failures re-issue; the third is the one that widens, and its step is left free for
      // the fourth session to pick up.
      for (let attempt = 1; attempt <= 2; attempt += 1) failAttempt(fixture, attempt);
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      fixture.engine.reap();
      // The fourth session writes and the gates hold: the ladder ends accepted, not refused.
      const run = runStubStep(fixture, {
        title: 'Начало',
        blocks: ['Тестовый абзац номер один. Это служебный текст, и он остаётся служебным.'],
      });
      expect(run?.revisions).toBe(0);
      // The step closed by its own write — the ladder ended accepted, never refused.
      expect(run?.result.outcome).toBe('rewritten');
      const step = fixture.db.prepare('SELECT outcome, widened FROM steps WHERE step_id = ?').get(first.stepId) as {
        outcome: string | null;
        widened: string | null;
      };
      expect(step).toEqual({ outcome: 'rewritten', widened: 'wider-edit' });

    } finally {
      fixture.close();
    }
  });

  it('the fifth hands over to the desperate sixth, and its failure is the close', () => {
    const { fixture, first } = started();
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) failAttempt(fixture, attempt);
      const step = fixture.db.prepare('SELECT desperate, outcome FROM steps WHERE step_id = ?').get(first.stepId) as {
        desperate: number;
        outcome: string | null;
      };
      expect(step).toEqual({ desperate: 1, outcome: null });

      const sixth = fixture.engine.next({ for: 'fwd', session: 'fwd-6' }) as WriterAssignment;
      expect(sixth.attempt).toBe(6);
      expect(sixth.maxAttempts).toBe(6);
      expect(sixth.desperate).toBe(true);
      expect(sixth.deadlineAt - Date.parse(new Date(fixture.clock.ms).toISOString())).toBe(180_000);

      // The sixth dies too: the ladder is over.
      fixture.clock.advance(fixture.config.leaseTtlMs + 1_000);
      fixture.engine.reap();
      const closed = fixture.db.prepare('SELECT outcome FROM steps WHERE step_id = ?').get(first.stepId) as {
        outcome: string | null;
      };
      expect(closed.outcome).toBe('escalated');
    } finally {
      fixture.close();
    }
  });
});
