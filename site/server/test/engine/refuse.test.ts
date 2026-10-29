/**
 * The refusal — one of the two ends a filing has (owner's invariant, 2026-10-29).
 *
 * «У нас не должно быть вариантов зайти в тупик — всегда должны прийти в два варианта: или
 * отклонён, или принят и написан.» A change is `done` (its text in the chapter) or `void · dropped`
 * (no text of it in the book); a step stopped by a rule puts its text back, and the queue's own
 * deadlines are enforced by the tick, not by an operator. These tests drive the protocol, then
 * read the rows: the chapter's revisions, the change, the filing's derived state and the event
 * the site's bridge turns into the reader's `comment:decision`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { filingStatus } from '../../src/comments/filingState.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineError } from '../../src/engine/types.ts';
import { toIso } from '../../src/util/time.ts';
import { chapterText, createEngineFixture, type Fixture } from './helpers.ts';

const QUEUE_HOURS = 6;

function refusalOf(run: () => unknown): EngineError | null {
  try {
    run();
    return null;
  } catch (error) {
    return error as EngineError;
  }
}

function chapterOne(): Fixture {
  return createEngineFixture({ chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) }, filings: 'manual' });
}

/** One change on ch01, landed and waiting for its gates — the shape a wall or a window stops. */
function landedChange(fixture: Fixture): { changeId: string; assignment: WriterAssignment; before: string } {
  const before = fixture.readChapter(1) ?? '';
  const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац.', 'Второй абзац.']);
  fixture.engine.land(assignment.leaseId);
  return { changeId: change.id, assignment, before };
}

function revisionsOf(fixture: Fixture): Array<{ rev: number; kind: string }> {
  return fixture.db
    .prepare('SELECT rev, kind FROM revisions WHERE chapter = 1 ORDER BY rev DESC')
    .all() as Array<{ rev: number; kind: string }>;
}

function changeOf(fixture: Fixture, id: string): store.ChangeRow | undefined {
  return store.getChange(fixture.db, id);
}

/** What the page reads for the filing: `accepted` before the lane, then the change's own answer. */
function filingStateOf(fixture: Fixture, id: string): string {
  const change = changeOf(fixture, id);
  if (change === undefined) throw new Error(`no change ${id}`);
  return filingStatus(
    { id: change.id, seq: change.seq, premise: change.premise, status: change.status, outcome: change.outcome, reason: change.reason, chapter: change.chapter },
    'accepted',
  );
}

/** The row the site's bridge reads: one `decided` change_event per decision, never two. */
function decisionEvents(fixture: Fixture, id: string): Array<{ meta: string }> {
  return fixture.db
    .prepare("SELECT meta FROM change_events WHERE change_id = ? AND type = 'decided'")
    .all(id) as Array<{ meta: string }>;
}

describe('the wall is a refusal (BOOK-34, owner’s invariant)', () => {
  it('puts the chapter back to its pre-pass revision and refuses the change with one sentence', () => {
    const fixture = chapterOne();
    try {
      const { changeId, assignment, before } = landedChange(fixture);
      const revBefore = store.getStep(fixture.db, assignment.stepId)?.rev_before ?? 0;
      expect(fixture.readChapter(1)).not.toBe(before);

      fixture.clock.advance(fixture.config.stepWallMs + 60_000);
      expect(fixture.engine.reap().stepWalls).toEqual([assignment.stepId]);

      // The text is back, as a revision of its own (`cause_kind = 'restore'`), at the pre-pass rev.
      expect(fixture.readChapter(1)).toBe(before);
      const revisions = revisionsOf(fixture);
      expect(revisions[0]).toMatchObject({ kind: 'restore' });
      expect(fixture.db.prepare('SELECT rev FROM chapters WHERE n = 1').get()).toEqual({ rev: (revisions[0]?.rev ?? 0) });

      // The change is refused: `void · dropped` with one public sentence, and the filing reads it.
      const change = changeOf(fixture, changeId);
      expect(change).toMatchObject({ status: 'void', outcome: 'dropped' });
      expect(change?.reason).toContain('отведённое время');
      expect(change?.reason).not.toContain('_');
      expect(revBefore).toBeGreaterThanOrEqual(1);

      // The step keeps the engine's own word for a stop, and the filing one terminal answer.
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBe('escalated');
      expect(filingStateOf(fixture, changeId)).toBe('rejected');
      const decisions = decisionEvents(fixture, changeId);
      expect(decisions).toHaveLength(1);
      expect(JSON.parse(decisions[0]?.meta ?? '{}')).toMatchObject({ outcome: 'dropped' });
      expect(fixture.alerts.filter((alert) => alert.changeId === changeId)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it('refuses a gate that never answered, and never leaves `escalated` as a change status', () => {
    const fixture = chapterOne();
    try {
      const { changeId, assignment, before } = landedChange(fixture);
      const gate = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      expect(gate.stepId).toBe(assignment.stepId);

      fixture.clock.advance(fixture.config.gateTtlMs + 1_000);
      expect(fixture.engine.reap().gateTimeouts).toEqual([assignment.stepId]);

      expect(fixture.readChapter(1)).toBe(before);
      expect(revisionsOf(fixture)[0]?.kind).toBe('restore');
      const change = changeOf(fixture, changeId);
      expect(change).toMatchObject({ status: 'void', outcome: 'dropped' });
      expect(change?.reason).toContain('проверка не ответила');
      expect(filingStateOf(fixture, changeId)).toBe('rejected');
      expect(
        (fixture.db.prepare(`SELECT COUNT(*) AS n FROM changes WHERE status = 'escalated'`).get() as { n: number }).n,
      ).toBe(0);
    } finally {
      fixture.close();
    }
  });
});

describe('the writer’s stop is the refusal', () => {
  it('closes the change void·dropped with the writer’s sentence, and puts the text back', () => {
    const fixture = chapterOne();
    try {
      const { changeId, assignment, before } = landedChange(fixture);

      const done = fixture.engine.escalate(assignment.leaseId, 'не беру: сцена не из этой главы');

      expect(done.outcome).toBe('escalated');
      expect(done.changeStatus).toBe('void');
      expect(fixture.readChapter(1)).toBe(before);
      const change = changeOf(fixture, changeId);
      expect(change).toMatchObject({ status: 'void', outcome: 'dropped', reason: 'не беру: сцена не из этой главы' });
      expect(filingStateOf(fixture, changeId)).toBe('rejected');
      // The reader's own door hears it exactly once, and the lane is free for the next filing.
      expect(decisionEvents(fixture, changeId)).toHaveLength(1);
      expect(store.readLane(fixture.db).holder).toBeNull();
      expect(fixture.engine.reap().stepWalls).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('answers TEXT_STUCK and closes nothing when the chapter moved after the landing', () => {
    const fixture = chapterOne();
    try {
      const { changeId, assignment } = landedChange(fixture);
      // Somebody else wrote the chapter after the pass landed: restoring over them would throw
      // their work away, so the refusal must stop instead of deciding.
      fixture.seedChapterBlocks(1, 'Начало', ['Чужой текст, написанный после прохода.']);
      const moved = fixture.readChapter(1);

      const refusal = refusalOf(() => fixture.engine.escalate(assignment.leaseId, 'не беру: сцена не из этой главы'));
      expect(refusal?.code).toBe('TEXT_STUCK');
      expect(refusal?.status).toBe(409);

      // Nothing was closed and nothing was put back over the newer text.
      expect(fixture.readChapter(1)).toBe(moved);
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBeNull();
      expect(changeOf(fixture, changeId)?.status).toBe('processing');
      expect(decisionEvents(fixture, changeId)).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
});

describe('a refusal that cannot publish its way back', () => {
  it('answers TEXT_STUCK when the pre-pass snapshot publishes nothing, and closes nothing', () => {
    const fixture = chapterOne();
    try {
      const { changeId, assignment } = landedChange(fixture);
      const revBefore = store.getStep(fixture.db, assignment.stepId)?.rev_before ?? 0;
      const row = fixture.db
        .prepare('SELECT snapshot FROM revisions WHERE chapter = 1 AND rev = ?')
        .get(revBefore) as { snapshot: string };
      // The snapshot is read back and parsed before the restore: an empty one publishes nothing,
      // so the way back cannot be made and the refusal must stop instead of deciding.
      writeFileSync(join(fixture.dataDir, row.snapshot), '', 'utf8');

      const refusal = refusalOf(() => fixture.engine.escalate(assignment.leaseId, 'не беру: сцена не из этой главы'));
      expect(refusal?.code).toBe('TEXT_STUCK');
      expect(store.getStep(fixture.db, assignment.stepId)?.outcome).toBeNull();
      expect(changeOf(fixture, changeId)?.status).toBe('processing');
      expect(decisionEvents(fixture, changeId)).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
});

describe('the queue is finite (QUEUE_DEADLINE_MS)', () => {
  it('refuses a pending change older than the deadline in one tick, and never hands it out', () => {
    const fixture = chapterOne();
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
      fixture.clock.advance(QUEUE_HOURS * 3_600_000 + 1_000);

      const report = fixture.engine.reap();
      expect(report.refused).toEqual([change.id]);
      const row = changeOf(fixture, change.id);
      expect(row).toMatchObject({ status: 'void', outcome: 'dropped' });
      expect(row?.reason).toBe('не дошло до прохода за 6 ч — заявка отклонена');
      expect(filingStateOf(fixture, change.id)).toBe('rejected');
      expect(decisionEvents(fixture, change.id)).toHaveLength(1);

      // The tick is the enforcer: the next poll hands nothing out and creates no step.
      expect(fixture.engine.next({ for: 'filing', session: 'writer-1' })).toBeNull();
      expect(store.countOpenSteps(fixture.db)).toBe(0);
      // A second tick does not decide the row twice.
      expect(fixture.engine.reap().refused).toEqual([]);
      expect(decisionEvents(fixture, change.id)).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it('refuses a premise the queue never reached either — the filing is the same fact', () => {
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      const premise = fixture.engine.enqueue({ kind: 'reader_edit', chapter: 3, intent: 'глава о дороге' });
      expect(changeOf(fixture, premise.id)?.premise).toBe(1);
      fixture.clock.advance(QUEUE_HOURS * 3_600_000 + 1_000);
      expect(fixture.engine.reap().refused).toEqual([premise.id]);
      expect(changeOf(fixture, premise.id)).toMatchObject({ status: 'void', outcome: 'dropped' });
      expect(filingStateOf(fixture, premise.id)).toBe('rejected');
    } finally {
      fixture.close();
    }
  });

  it('leaves a young filing alone', () => {
    const fixture = chapterOne();
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
      fixture.clock.advance(QUEUE_HOURS * 3_600_000 - 60_000);
      expect(fixture.engine.reap().refused).toEqual([]);
      expect(changeOf(fixture, change.id)?.status).toBe('pending');
    } finally {
      fixture.close();
    }
  });

  it('refuses the queue at once when the book’s money cap is spent, with the money sentence', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
      filings: 'manual',
      env: { BOOK_BUDGET_BOOK_USD: '1' },
    });
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
      const at = toIso(fixture.clock.now());
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
           VALUES (?, ?, 'stp_seeded', 1, 'change', NULL, 0, 0, 2, 1)`,
        )
        .run(at, at.slice(0, 10));

      // The day's pause waits (it lifts at 00:00 UTC); the book's stop does not.
      const report = fixture.engine.reap();
      expect(report.refused).toEqual([change.id]);
      expect(changeOf(fixture, change.id)).toMatchObject({ status: 'void', outcome: 'dropped' });
      expect(changeOf(fixture, change.id)?.reason).toBe('потолок книги исчерпан — заявка отклонена');
      expect(filingStateOf(fixture, change.id)).toBe('rejected');
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('budget');
      expect(store.readLane(fixture.db).holder).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('waits out a day’s pause instead of refusing the queue: only the deadline ends it', () => {
    // A pause lifts by itself at 00:00 UTC, so a paused queue is still a queue; the book's stop
    // (the previous case) is the one that refuses at once.
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
      filings: 'manual',
      env: { BOOK_BUDGET_DAY_USD: '1' },
    });
    try {
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
      const at = toIso(fixture.clock.now());
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
           VALUES (?, ?, 'stp_paused', 1, 'change', NULL, 0, 0, 2, 1)`,
        )
        .run(at, at.slice(0, 10));
      expect(fixture.engine.state().budget.state).toBe('pause');
      expect(fixture.engine.reap().refused).toEqual([]);
      expect(changeOf(fixture, change.id)?.status).toBe('pending');
      // And the pause still ends where every queued filing ends: at the deadline.
      fixture.clock.advance(QUEUE_HOURS * 3_600_000 + 1_000);
      expect(fixture.engine.reap().refused).toEqual([change.id]);
    } finally {
      fixture.close();
    }
  });

  it('does not refuse a premise whose first pass is running on that chapter', () => {
    // A pass is the premise's own answer: its step wall bounds it, and the queue's deadline must
    // not decide a filing under the session that is writing it.
    const fixture = createEngineFixture({ filings: 'manual' });
    try {
      // The filing is old, and the pass that answers it opens on the last minute of its deadline:
      // the step is fresh (well inside the 45-minute wall) while the row is past the 6 hours.
      const premise = fixture.engine.enqueue({ kind: 'reader_edit', chapter: 3, intent: 'глава о дороге' });
      fixture.clock.advance(QUEUE_HOURS * 3_600_000 - 60_000);
      const pass = fixture.engine.openChapterPass(3, 'writer-3');
      expect(pass).not.toBeNull();
      fixture.clock.advance(120_000);
      expect(fixture.engine.reap().refused).toEqual([]);
      expect(changeOf(fixture, premise.id)?.status).toBe('pending');
      expect(store.getStep(fixture.db, pass?.stepId ?? '')?.outcome).toBeNull();
    } finally {
      fixture.close();
    }
  });
});
