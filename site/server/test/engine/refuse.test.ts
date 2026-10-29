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

import { QUEUE_MAX_ATTEMPTS, type WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { filingStatus } from '../../src/comments/filingState.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineError } from '../../src/engine/types.ts';
import { toIso } from '../../src/util/time.ts';
import { chapterText, createEngineFixture, type Fixture } from './helpers.ts';

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

describe('the queue is finite by attempts, not by hours (owner, 2026-10-29)', () => {
  /**
   * Hold the lane with a change that is really processing: a `pending` change behind it cannot
   * start, and every poll is one counted claim that produced no step.
   */
  function blockedBy(fixture: Fixture): void {
    const first = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'среда вместо четверга' });
    expect(fixture.engine.next({ for: 'fwd', session: 'writer-hold' })).not.toBeNull();
    expect(changeOf(fixture, first.id)?.status).toBe('processing');
  }

  function poll(fixture: Fixture, session: string): void {
    expect(fixture.engine.next({ for: 'fwd', session })).toBeNull();
  }

  it('drops a change after six claims that produced no step, and the filing with it', () => {
    const fixture = chapterOne();
    try {
      blockedBy(fixture);
      const change = fixture.engine.enqueue({ kind: 'operator', chapter: 1, intent: 'четверг вместо среды' });

      for (let claim = 1; claim < QUEUE_MAX_ATTEMPTS; claim += 1) {
        poll(fixture, `writer-${String(claim)}`);
        expect(changeOf(fixture, change.id)).toMatchObject({ status: 'pending', attempts: claim });
      }
      // Still pending below the bound: five counted claims are five attempts, not a verdict.
      expect(decisionEvents(fixture, change.id)).toHaveLength(0);

      poll(fixture, 'writer-last');
      const row = changeOf(fixture, change.id);
      expect(row).toMatchObject({ status: 'void', outcome: 'dropped', attempts: QUEUE_MAX_ATTEMPTS });
      expect(row?.reason).toBe('заявка не дошла до главы за 6 попыток');
      expect(filingStateOf(fixture, change.id)).toBe('rejected');
      // One decision frame for the reader, and one only.
      expect(decisionEvents(fixture, change.id)).toHaveLength(1);

      // A seventh attempt is impossible: the change has left the queue and no counter moves.
      poll(fixture, 'writer-extra');
      expect(changeOf(fixture, change.id)).toMatchObject({ attempts: QUEUE_MAX_ATTEMPTS });
      expect(decisionEvents(fixture, change.id)).toHaveLength(1);
      expect(store.countOpenSteps(fixture.db)).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('counts a premise the lane never reached either — the filing is the same fact', () => {
    const fixture = createEngineFixture({
      chapters: { 1: chapterText('Начало', ['Тестовый абзац.']) },
      filings: 'manual',
      env: { BOOK_BUDGET_DAY_USD: '1' },
    });
    try {
      const at = toIso(fixture.clock.now());
      fixture.db
        .prepare(
          `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, model, tokens_in, tokens_out, usd, priced)
           VALUES (?, ?, 'stp_paused', 1, 'change', NULL, 0, 0, 2, 1)`,
        )
        .run(at, at.slice(0, 10));
      const premise = fixture.engine.enqueue({ kind: 'reader_edit', chapter: 3, intent: 'глава о дороге' });
      expect(changeOf(fixture, premise.id)?.premise).toBe(1);

      // A paused day waits, and each re-issue of the waiting premise counts: the bound holds even
      // when nothing is spent. The poll answers the pause's own code, never a decision.
      for (let claim = 1; claim < QUEUE_MAX_ATTEMPTS; claim += 1) {
        expect(refusalOf(() => fixture.engine.next({ for: 'fwd', session: `writer-${String(claim)}` }))?.code).toBe(
          'BUDGET_PAUSED',
        );
        expect(changeOf(fixture, premise.id)).toMatchObject({ status: 'pending', attempts: claim });
      }
      expect(refusalOf(() => fixture.engine.next({ for: 'fwd', session: 'writer-last' }))?.code).toBe('BUDGET_PAUSED');
      expect(changeOf(fixture, premise.id)).toMatchObject({
        status: 'void',
        outcome: 'dropped',
        attempts: QUEUE_MAX_ATTEMPTS,
      });
      expect(changeOf(fixture, premise.id)?.reason).toBe('заявка не дошла до главы за 6 попыток');
      expect(filingStateOf(fixture, premise.id)).toBe('rejected');
    } finally {
      fixture.close();
    }
  });

  it('refuses the queue at once when the book’s money cap is spent, spending no attempt', () => {
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

      // The stop is a refusal at once: it neither waits nor spends a claim.
      const report = fixture.engine.reap();
      expect(report.refused).toEqual([change.id]);
      expect(changeOf(fixture, change.id)).toMatchObject({ status: 'void', outcome: 'dropped', attempts: 0 });
      expect(changeOf(fixture, change.id)?.reason).toBe('потолок книги исчерпан — заявка отклонена');
      expect(filingStateOf(fixture, change.id)).toBe('rejected');
      expect(fixture.alerts.map((alert) => alert.kind)).toContain('budget');
      expect(store.readLane(fixture.db).holder).toBeNull();
    } finally {
      fixture.close();
    }
  });
});
