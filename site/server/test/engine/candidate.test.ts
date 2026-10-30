/**
 * BOOK-222 — a landing is a candidate until the close (the owner's defect, 2026-10-29).
 *
 * The measured failure: a draft was published as revision 14, the gate call then failed with
 * `PROVIDER_SHAPE`, the pass rolled the chapter back and the change closed as a stop — and the
 * reader read our failed check as a refusal of his filing. The rule these tests hold:
 *
 *  · a **provisional** land validates the text (size, frame, the rights scan of its delta), holds
 *    it on the step as a candidate and publishes **nothing** — the reader keeps the chapter he has;
 *  · the gates read the candidate (`landedSha` is its sha) and an answer about a candidate that
 *    moved is `CANDIDATE_MOVED`, never a blessing of text nobody read;
 *  · `done` publishes the candidate through the same applier `land` uses, exactly once, and writes
 *    `landed_*` only then; a refusal drops the candidate and leaves the chapter and its revision
 *    untouched — there is nothing to restore because nothing was served.
 */

import type { WriterAssignment } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { buildControl } from '../../src/engine/control.ts';
import type { GateAssignment } from '../../src/engine/gates.ts';
import { GATE_WINDOW_REASON } from '../../src/engine/refuse.ts';
import * as store from '../../src/engine/store.ts';
import type { EngineError } from '../../src/engine/types.ts';
import { PIPELINE_MODEL, chapterText, createEngineFixture, submitRights, type Fixture } from './helpers.ts';

function revisions(fixture: Fixture): number {
  return (fixture.db.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n;
}

function changePass(fixture: Fixture): WriterAssignment {
  fixture.engine.enqueue({ kind: 'accepted_comment', chapter: 1, intent: 'среда вместо четверга' });
  const assignment = fixture.engine.next({ for: 'fwd', session: 'writer-1' }) as WriterAssignment;
  fixture.engine.start(assignment.leaseId);
  return assignment;
}

/** The candidate's text, staged and landed provisionally — nothing is served. */
function provisionalLand(fixture: Fixture, assignment: WriterAssignment, blocks: string[]): string {
  // `writeChapterBlocks` keeps the canon frame of ch01, exactly as a live session must.
  fixture.writeChapterBlocks(1, 'Начало', blocks);
  const landed = fixture.engine.land(assignment.leaseId, { provisional: true });
  expect(landed.provisional).toBe(true);
  return landed.sha;
}

function answer(fixture: Fixture, role: 'editor' | 'consultant'): void {
  const gate = fixture.engine.next({ role, session: `${role}-1` }) as GateAssignment | null;
  if (gate === null) throw new Error(`no ${role} assignment`);
  fixture.engine.verdict(gate.stepId, {
    role,
    session: gate.session,
    verdict: 'HOLDS',
    findings: [],
    model: PIPELINE_MODEL,
    tokensIn: 90,
    tokensOut: 9,
  });
}

/** The change this step belongs to (its lease names it), never «the newest change». */
function changeOf(
  fixture: Fixture,
  assignment: WriterAssignment,
): { status: string; outcome: string | null; reason: string | null } {
  return fixture.db
    .prepare(
      `SELECT c.status AS status, c.outcome AS outcome, c.reason AS reason FROM changes c
         JOIN leases l ON l.change_id = c.id WHERE l.step_id = ?`,
    )
    .get(assignment.stepId) as { status: string; outcome: string | null; reason: string | null };
}

function seeded(): Fixture {
  return createEngineFixture({ chapters: { 1: chapterText('Начало', ['Первый абзац главы.', 'Второй абзац главы.']) } });
}

describe('a provisional land publishes nothing (BOOK-222)', () => {
  it('holds the text as a candidate, and `done` publishes exactly one revision', () => {
    const fixture = seeded();
    try {
      const served = fixture.readChapter(1);
      const published = revisions(fixture);
      const assignment = changePass(fixture);
      const sha = provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Второй абзац изменён.']);

      // Between the land and the close the reader sees exactly what he saw before.
      const held = store.getStep(fixture.db, assignment.stepId);
      expect(held?.candidate_sha).toBe(sha);
      expect(held?.candidate_text).not.toBeNull();
      expect(held?.landed_at).toBeNull();
      expect(held?.landed_sha).toBeNull();
      expect(fixture.readChapter(1)).toBe(served);
      expect(revisions(fixture)).toBe(published);

      // The gates read the candidate, not a landing — and the text door quotes it, so a gate's
      // prompt is the text whose sha the verdict is bound to.
      const gate = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      expect(gate.landedSha).toBe(sha);
      const quoted = fixture.engine.text([1]).chapters[0];
      expect(quoted?.text).toContain('Второй абзац изменён.');
      expect(quoted?.text).not.toContain('Второй абзац главы.');

      answer(fixture, 'editor');
      answer(fixture, 'consultant');
      submitRights(fixture);

      // Still nothing served until the close.
      expect(fixture.readChapter(1)).toBe(served);
      expect(revisions(fixture)).toBe(published);

      const done = fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
      expect(done.changeStatus).toBe('done');

      const closed = store.getStep(fixture.db, assignment.stepId);
      expect(closed?.landed_sha).toBe(sha);
      expect(closed?.landed_at).not.toBeNull();
      expect(closed?.candidate_sha).toBeNull();
      expect(closed?.candidate_text).toBeNull();
      expect(revisions(fixture)).toBe(published + 1);
      expect(fixture.readChapter(1)).toContain('Второй абзац изменён.');
      expect(changeOf(fixture, assignment).status).toBe('done');
    } finally {
      fixture.close();
    }
  });

  it('a refusal after a provisional land leaves the served chapter and its revision untouched', () => {
    const fixture = seeded();
    try {
      const served = fixture.readChapter(1);
      const published = revisions(fixture);
      const assignment = changePass(fixture);
      provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Второй абзац отклонён.']);

      // The writer's own stop — the refusal sink, not an `escalated` change.
      const stopped = fixture.engine.escalate(assignment.leaseId, 'не принято: правка не по книге', {
        model: PIPELINE_MODEL,
      });
      expect(stopped.changeStatus).toBe('void');

      const step = store.getStep(fixture.db, assignment.stepId);
      expect(step?.outcome).toBe('escalated');
      expect(step?.candidate_sha).toBeNull();
      expect(step?.candidate_text).toBeNull();
      expect(step?.landed_at).toBeNull();
      // No restore, because there was nothing to restore: the chapter never moved.
      expect(fixture.readChapter(1)).toBe(served);
      expect(revisions(fixture)).toBe(published);
      const change = changeOf(fixture, assignment);
      expect([change.status, change.outcome]).toEqual(['void', 'dropped']);
    } finally {
      fixture.close();
    }
  });

  it('a second provisional land on the same sha is a no-op; a different one replaces the candidate', () => {
    const fixture = seeded();
    try {
      const assignment = changePass(fixture);
      const sha = provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Второй абзац изменён.']);
      const again = fixture.engine.land(assignment.leaseId, { provisional: true });
      expect(again).toMatchObject({ landed: true, provisional: true, sha, changed: false });
      expect(store.getStep(fixture.db, assignment.stepId)?.candidate_sha).toBe(sha);

      // A different attempt wins: the candidate is the latest text, and it still is not served.
      const next = fixture.engine.land(assignment.leaseId, { provisional: true });
      expect(next.sha).toBe(sha);
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац главы.', 'Третий вариант.']);
      const replaced = fixture.engine.land(assignment.leaseId, { provisional: true });
      expect(replaced.sha).not.toBe(sha);
      expect(store.getStep(fixture.db, assignment.stepId)?.candidate_sha).toBe(replaced.sha);
      expect(fixture.readChapter(1)).not.toContain('Третий вариант.');
    } finally {
      fixture.close();
    }
  });

  it('the gate window refuses a step that never published: the sentence does not claim a restore', () => {
    const fixture = seeded();
    try {
      const served = fixture.readChapter(1);
      const published = revisions(fixture);
      const assignment = changePass(fixture);
      provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Второй абзац изменён.']);
      // The editor was handed the candidate and never answered.
      expect(fixture.engine.next({ role: 'editor', session: 'editor-1' })).not.toBeNull();

      fixture.clock.advance(fixture.config.gateTtlMs + 60_000);
      const report = fixture.engine.reap();
      expect(report.gateTimeouts).toContain(assignment.stepId);

      const step = store.getStep(fixture.db, assignment.stepId);
      expect(step?.outcome).toBe('escalated');
      expect(step?.candidate_sha).toBeNull();
      expect(fixture.readChapter(1)).toBe(served);
      expect(revisions(fixture)).toBe(published);
      const change = changeOf(fixture, assignment);
      expect([change.status, change.outcome]).toEqual(['void', 'dropped']);
      // The reader hears whose failure it was; the note keeps the fact that nothing was served.
      expect(change.reason).toBe(GATE_WINDOW_REASON);
      expect(step?.note).toContain('правка не опубликована');
    } finally {
      fixture.close();
    }
  });

  it('a verdict for a candidate that moved is `CANDIDATE_MOVED`, not a blessing', () => {
    const fixture = seeded();
    try {
      const assignment = changePass(fixture);
      const first = provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Первый вариант.']);
      const gate = fixture.engine.next({ role: 'editor', session: 'editor-1' }) as GateAssignment;
      expect(gate.landedSha).toBe(first);

      // A second attempt replaces the candidate: the gate read a text the step no longer holds.
      const second = provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Второй вариант.']);
      expect(second).not.toBe(first);
      const step = store.getStep(fixture.db, assignment.stepId);
      expect(step?.candidate_sha).toBe(second);
      // The verdicts about the replaced text are dropped: nobody blessed the new one.
      expect(store.getVerdict(fixture.db, assignment.stepId, 'editor')).toBeUndefined();

      let refusal: EngineError | null = null;
      try {
        fixture.engine.verdict(gate.stepId, {
          role: 'editor',
          session: gate.session,
          verdict: 'HOLDS',
          findings: [],
          model: PIPELINE_MODEL,
          tokensIn: 10,
          tokensOut: 1,
        });
      } catch (error) {
        refusal = error as EngineError;
      }
      expect(refusal?.code).toBe('CANDIDATE_MOVED');
      expect(fixture.readChapter(1)).not.toContain('Первый вариант.');
      expect(fixture.readChapter(1)).not.toContain('Второй вариант.');
    } finally {
      fixture.close();
    }
  });
});

describe('the patch’s edits travel with the candidate (BOOK-222)', () => {
  /** One well-formed character edit, shaped as `sentences/transform.ts` reads it. */
  const EDIT = {
    blockId: 'bkd_old',
    newBlockId: 'bkd_new',
    oldText: 'Второй абзац главы.',
    newText: 'Второй абзац изменён.',
    from: 0,
    oldFragment: 'Второй абзац главы.',
    newFragment: 'Второй абзац изменён.',
  };

  it('holds the edits a landing carried, and the publish reads them and clears them', () => {
    const fixture = seeded();
    try {
      const assignment = changePass(fixture);
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац главы.', 'Второй абзац изменён.']);
      const landed = fixture.engine.land(assignment.leaseId, { provisional: true, sentences: [EDIT] });
      expect(landed.provisional).toBe(true);
      // The publish is the only moment these can be applied, so they wait beside the text.
      expect(store.getStep(fixture.db, assignment.stepId)?.candidate_sentences).toBe(JSON.stringify([EDIT]));

      answer(fixture, 'editor');
      answer(fixture, 'consultant');
      submitRights(fixture);
      const done = fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
      expect(done.outcome).toBe('rewritten');
      expect(fixture.readChapter(1)).toContain('Второй абзац изменён.');
      expect(store.getStep(fixture.db, assignment.stepId)?.candidate_sentences).toBeNull();
    } finally {
      fixture.close();
    }
  });

  it('drops the edits a replacing candidate does not carry', () => {
    const fixture = seeded();
    try {
      const assignment = changePass(fixture);
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац главы.', 'Второй абзац изменён.']);
      const landed = fixture.engine.land(assignment.leaseId, { provisional: true, sentences: [EDIT] });

      // A new attempt carries no patch: the stale edits describe a text nobody lands any more.
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац главы.', 'Третий вариант.']);
      const replaced = fixture.engine.land(assignment.leaseId, { provisional: true });
      expect(replaced.sha).not.toBe(landed.sha);
      expect(store.getStep(fixture.db, assignment.stepId)?.candidate_sentences).toBeNull();
    } finally {
      fixture.close();
    }
  });

  for (const raw of ['not json', '{"a":1}', '[{"blockId":5}]']) {
    it(`publishes a candidate whose edit set reads as «none»: ${raw}`, () => {
      const fixture = seeded();
      try {
        const assignment = changePass(fixture);
        provisionalLand(fixture, assignment, ['Первый абзац главы.', 'Второй абзац изменён.']);
        // An edit set no reader could vouch for: the publish re-segments the text (the behaviour of
        // a build that carried none) instead of writing a sentence row nobody named.
        fixture.db
          .prepare('UPDATE steps SET candidate_sentences = ? WHERE step_id = ?')
          .run(raw, assignment.stepId);
        answer(fixture, 'editor');
        answer(fixture, 'consultant');
        submitRights(fixture);

        const done = fixture.engine.done(assignment.leaseId, { seams: [], model: PIPELINE_MODEL });
        expect(done.outcome).toBe('rewritten');
        expect(fixture.readChapter(1)).toContain('Второй абзац изменён.');
        expect(store.getStep(fixture.db, assignment.stepId)?.candidate_sentences).toBeNull();
      } finally {
        fixture.close();
      }
    });
  }
});

describe('the door says what it did (BOOK-222)', () => {
  it('`POST /internal/land` answers `{ landed, provisional, sha }` and serves nothing', async () => {
    const fixture = seeded();
    const app = await buildControl({ engine: fixture.engine, token: 'test-token', logger: false });
    try {
      const served = fixture.readChapter(1);
      const assignment = changePass(fixture);
      // The fixture's staged text is the session's answer; the route carries only the flag.
      fixture.writeChapterBlocks(1, 'Начало', ['Первый абзац главы.', 'Второй абзац через дверь.']);
      const answer = await app.inject({
        method: 'POST',
        url: '/internal/land',
        headers: { authorization: 'Bearer test-token' },
        payload: { leaseId: assignment.leaseId, provisional: true },
      });
      expect(answer.statusCode).toBe(200);
      const data = answer.json().data as { landed: boolean; provisional?: boolean; sha: string };
      expect(data.landed).toBe(true);
      expect(data.provisional).toBe(true);
      expect(data.sha).toBe(store.getStep(fixture.db, assignment.stepId)?.candidate_sha);
      expect(fixture.readChapter(1)).toBe(served);
    } finally {
      await app.close();
      fixture.close();
    }
  });
});
