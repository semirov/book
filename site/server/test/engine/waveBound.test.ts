import type { WriterAssignment } from '@book/shared';
import { CASCADE_MAX_WAVE } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { createEngineFixture, DEFAULT_ABOUT, driveStub, type Fixture } from './helpers.ts';

/**
 * BOOK-DOC-4 rule 3 end to end, on the shipped budget: a change makes one wave — both wings
 * step in it — and the next one is refused until the owner decides; the front and ending
 * proofs carry the wave the ripple rests in, so the recorded `cascades.wave` never exceeds
 * the promise, and that rest is not an escalation.
 */

function bookBlocks(n: number): string[] {
  return Array.from({ length: 8 }, (_, index) => {
    const tail = 'Служебный абзац для проверки объёма. Это предложение повторяется, чтобы набрать нужную длину, и не является текстом книги.';
    return `Абзац ${index + 1} главы ${n}. ${tail}`;
  });
}

function book(fixture: Fixture, from: number, to: number): void {
  for (let n = from; n <= to; n += 1) fixture.writeChapterBlocks(n, `Глава ${n}`, bookBlocks(n));
}

type ChangeRow = { status: string; outcome: string | null; reason: string | null };

function changeRow(fixture: Fixture, id: string): ChangeRow {
  return fixture.db.prepare('SELECT status, outcome, reason FROM changes WHERE id = ?').get(id) as ChangeRow;
}

/** The next job a writer session would take, from the lane the open steps belong to. */
function nextOf(fixture: Fixture): WriterAssignment | null {
  // `engine.next` falls through to a *draft* when no open step matches the asked lane, and a
  // cascade keeps the lane's head away, so ask the lane the open steps actually live in.
  const lanes = new Set(
    (fixture.db.prepare('SELECT lane FROM steps WHERE outcome IS NULL').all() as Array<{ lane: string | null }>).map(
      (row) => (row.lane === 'backward' ? 'bwd' : row.lane === 'forward' ? 'fwd' : null),
    ),
  );
  const lane: 'bwd' | 'fwd' = lanes.has('bwd') || lanes.has(null) || lanes.size === 0 ? 'bwd' : 'fwd';
  return fixture.engine.next({ for: lane, session: `writer-${lane}` }) as WriterAssignment | null;
}

function stepWave(fixture: Fixture, stepId: string): number {
  return (fixture.db.prepare('SELECT wave FROM steps WHERE step_id = ?').get(stepId) as { wave: number }).wave;
}

/**
 * Drive the ripple until the change is decided. `continues` decides, per landed step, whether
 * it reports an outer seam (the wing moves on) or holds (the wing has found its rest).
 */
function runRipple(
  fixture: Fixture,
  changeId: string,
  continues: (assignment: WriterAssignment) => boolean,
): WriterAssignment[] {
  const driven: WriterAssignment[] = [];
  for (let guard = 0; guard < 30; guard += 1) {
    const row = changeRow(fixture, changeId);
    if (row.status !== 'pending' && row.status !== 'processing') break;
    const assignment = nextOf(fixture);
    if (assignment === null) break;
    if (assignment.pass === 'draft') throw new Error('the harness was handed a draft step');
    driven.push(assignment);
    const chapter = assignment.chapter;
    const keep = continues(assignment) && chapter !== 'front' && chapter !== 67;
    driveStub(
      fixture,
      assignment,
      chapter === 'front'
        ? { title: 'Книга', blocks: [DEFAULT_ABOUT] }
        : { blocks: editBlock(chapter), seams: keep ? [{ boundary: chapter, reason: 'соседняя глава продолжает сцену' }] : [] },
    );
  }
  return driven;
}

function editBlock(n: number): string[] {
  return bookBlocks(n).map((block, index) => (index === 0 ? `Правленый первый абзац главы ${n}.` : block));
}

function wavesOf(fixture: Fixture, changeId: string): number[] {
  const rows = fixture.db
    .prepare(
      `SELECT s.wave FROM steps s JOIN cascades c ON c.id = s.cascade_id WHERE c.change_id = ? ORDER BY s.seq`,
    )
    .all(changeId) as Array<{ wave: number }>;
  return rows.map((row) => row.wave);
}

function cascadeOf(fixture: Fixture, changeId: string): { wave: number; status: string; outcome: string | null } {
  return fixture.db
    .prepare('SELECT wave, status, outcome FROM cascades WHERE change_id = ?')
    .get(changeId) as { wave: number; status: string; outcome: string | null };
}

describe('the wave bound on the shipped budget (BOOK-DOC-4 rule 3, BOOK-59)', () => {
  it('makes one wave in both wings, then asks for the decision that opens a second', () => {
    const fixture = createEngineFixture();
    book(fixture, 1, 20);
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 7, intent: 'связать сцены' });
      // Every landing reports a seam: both wings keep moving until the wave bound stops them.
      const driven = runRipple(fixture, change.id, () => true);

      const waves = wavesOf(fixture, change.id);
      // One wave is one round of both wings: the change itself, then chapters 6 and 8 at once.
      expect(driven).toHaveLength(1 + 2 * CASCADE_MAX_WAVE);
      expect(driven.filter((assignment) => assignment.pass === 'cascade').map((assignment) => assignment.chapter)).toEqual([
        6, 8,
      ]);
      expect(Math.max(...waves)).toBe(CASCADE_MAX_WAVE);
      expect(waves.every((wave) => wave <= CASCADE_MAX_WAVE)).toBe(true);

      // The stop is the normal way to go deeper: a decision line, not a budget failure.
      const row = changeRow(fixture, change.id);
      expect(row.status).toBe('escalated');
      expect(row.reason).toBe('правка сделала одну волну — вторая волна только по решению владельца');
      const cascade = cascadeOf(fixture, change.id);
      expect(cascade.status).toBe('escalated');
      expect(cascade.outcome).toBe('escalated:budget');
      expect(cascade.wave).toBe(CASCADE_MAX_WAVE);
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('budget');
    } finally {
      fixture.close();
    }
  });

  it('a ripple resting in wave 1 at the beginning records wave 1, not 2', () => {
    const fixture = createEngineFixture();
    book(fixture, 1, 12);
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 2, intent: 'связать сцены' });
      // Both wings come to rest on their first step; the beginning is proved, not rewritten.
      const driven = runRipple(fixture, change.id, (assignment) => assignment.pass === 'change');

      const front = driven.find((assignment) => assignment.pass === 'front');
      expect(front).toBeDefined();
      expect(stepWave(fixture, front?.stepId ?? '')).toBe(CASCADE_MAX_WAVE);
      const waves = wavesOf(fixture, change.id);
      expect(Math.max(...waves)).toBe(CASCADE_MAX_WAVE);
      expect(waves.every((wave) => wave <= CASCADE_MAX_WAVE)).toBe(true);

      // A proof of the beginning is a rest, not an escalation: the change stands.
      const row = changeRow(fixture, change.id);
      expect(row.status).toBe('done');
      expect(row.reason).toBeNull();
      const cascade = cascadeOf(fixture, change.id);
      expect(cascade).toEqual({ wave: CASCADE_MAX_WAVE, status: 'closed', outcome: 'absorbed' });
    } finally {
      fixture.close();
    }
  });

  it('a ripple resting in wave 1 at the end records wave 1, not 2', () => {
    const fixture = createEngineFixture();
    book(fixture, 55, 67);
    try {
      const change = fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 66, intent: 'связать сцены' });
      // Both wings rest at their first step; the upward one only has the ending to evaluate.
      const driven = runRipple(fixture, change.id, (assignment) => assignment.pass === 'change');

      const ending = driven.find((assignment) => assignment.pass === 'ending');
      expect(ending).toBeDefined();
      expect(stepWave(fixture, ending?.stepId ?? '')).toBe(CASCADE_MAX_WAVE);
      const waves = wavesOf(fixture, change.id);
      expect(Math.max(...waves)).toBe(CASCADE_MAX_WAVE);
      expect(waves.every((wave) => wave <= CASCADE_MAX_WAVE)).toBe(true);

      const row = changeRow(fixture, change.id);
      expect(row.status).toBe('done');
      const cascade = cascadeOf(fixture, change.id);
      expect(cascade).toEqual({ wave: CASCADE_MAX_WAVE, status: 'closed', outcome: 'absorbed' });
    } finally {
      fixture.close();
    }
  });
});
