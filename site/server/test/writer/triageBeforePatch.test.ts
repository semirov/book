/**
 * BOOK-206 (ADR-045) meets BOOK-173 (§4, §7): the patch path runs **after** the filing's read.
 *
 * The writer is the only process that holds a model key, so triage rides with it: the engine
 * claims an attempt out of the filing's own ledger, the writer stores one verdict, and the site's
 * applier places the reading as a `pending` change. Two properties follow, and both are rows here
 * rather than conventions:
 *
 *   • **one attempt, one claim.** The lane's claim of the *change* touches no `comment_attempts`
 *     row: the site writes the attempt, the engine's triage claim counts the try once, and the
 *     applier settles it. Nothing in the patch path writes or re-claims that ledger, so a filing
 *     is never claimed twice and no row is skipped.
 *   • **a verdict before a patch.** A change whose newest attempt is still `submitted` with no
 *     verdict is a filing nobody has judged: the pass refuses with `TRIAGE_REQUIRED`, calls no
 *     model and leaves the chapter and the step exactly as they stand.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { WriterAssignment } from '@book/shared';

import { latestAttempt, recordAttempt } from '../../src/comments/attempts.ts';
import { readCommentRow } from '../../src/comments/repo.ts';
import type { Db } from '../../src/db/db.ts';
import { runPass, type PassResult } from '../../src/writer/pass.ts';
import {
  BOOK_ROOT,
  answerOf,
  asSaid,
  attemptOf,
  bootTriage,
  changeOf,
  type Call,
  type Context,
} from '../filingTriageHarness.ts';

let context: Context | null = null;

afterEach(async () => {
  await context?.close();
  context = null;
});

function attemptsOf(db: Db, commentId: string): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM comment_attempts WHERE comment_id = ? ORDER BY n')
    .all(commentId) as Array<Record<string, unknown>>;
}

function chapterSha(db: Db, chapter: number): string {
  return (db.prepare('SELECT sha256 FROM chapters WHERE n = ?').get(chapter) as { sha256: string }).sha256;
}

describe('the patch path sits behind the filing’s read (BOOK-206 + BOOK-173)', () => {
  it('claims the change without touching the attempt ledger: one row, one claim, one settlement', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    // (1) Posting writes the attempt; nobody has claimed it and no change exists.
    expect(attemptsOf(db, id)).toHaveLength(1);
    expect(attemptOf(db, id)).toMatchObject({ n: 1, outcome: 'submitted', tries: 0, claim_by: null, verdict: null });
    expect(context.engine.next({ for: 'filing', session: context.config.session })).toBeNull();

    // (2) The writer's triage pulse claims it once and stores the one verdict.
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({
      n: 1,
      outcome: 'submitted',
      tries: 1,
      claim_by: context.config.session,
    });
    expect(latestAttempt(db, id)?.verdict).not.toBeNull();

    // (3) The applier places the reading and settles the same attempt; no second row appears.
    expect(context.place()).toBe(1);
    const settled = attemptOf(db, id);
    expect(settled).toMatchObject({ n: 1, outcome: 'accepted', tries: 1 });
    expect(attemptsOf(db, id)).toHaveLength(1);

    // (4) The lane claims the *change*. That claim is a lease and a step, never an attempt row:
    //     the ledger reads exactly as the applier left it — no second claim, no skipped attempt.
    const assignment = context.engine.next({
      for: 'filing',
      session: context.config.session,
    }) as WriterAssignment | null;
    expect(assignment).toMatchObject({ changeId: changeOf(db)?.id, chapter: 8 });
    expect(assignment?.triage).toEqual({ verdict: 'FITS', awaitingRead: false });
    expect(attemptOf(db, id)).toEqual(settled);
    expect(attemptsOf(db, id)).toHaveLength(1);
  });

  it('refuses a patch over a filing nobody has read, and writes nothing at all', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(context.place()).toBe(1);
    const change = changeOf(db);
    expect(change).toMatchObject({ status: 'pending', source_comment: id, scope_hint: 'phrase' });

    // The shape BOOK-206 owes a patch: a newer submission that no model has judged yet — the row
    // a re-opened filing arms and a fresh arrival writes. Its verdict is missing, so the words
    // the change would patch are not the words anyone read.
    const row = readCommentRow(db, id);
    if (row === undefined) throw new Error('the posted filing has no row');
    recordAttempt(db, row, new Date(context.h.clock.ms + 1_000).toISOString());
    expect(latestAttempt(db, id)).toMatchObject({ n: 2, outcome: 'submitted', verdict: null });

    const shaBefore = chapterSha(db, 8);
    const revisionsBefore = db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = 8').get();
    let providerCalled = false;
    const harness = context;
    const provider = async (): Promise<never> => {
      providerCalled = true;
      throw new Error('the model must not be called for an unread filing');
    };
    const result: PassResult = await runPass({
      config: harness.config,
      bookRoot: BOOK_ROOT,
      engine: harness.client,
      provider,
      now: () => harness.h.clock.ms,
      log: () => {},
      lanes: ['filing'],
    });

    expect(result.status).toBe('refused');
    expect(result.code).toBe('TRIAGE_REQUIRED');
    expect(result.reason).not.toContain('TRIAGE_REQUIRED');
    expect(providerCalled).toBe(false);
    // Nothing was written: the chapter's bytes, the revisions and the plan are as they were. The
    // change is claimed (the lane holds it while the step stands) and no step is closed — a
    // refusal is neither a landing nor a defect.
    expect(chapterSha(db, 8)).toBe(shaBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM revisions WHERE chapter = 8').get()).toEqual(revisionsBefore);
    expect(db.prepare('SELECT COUNT(*) AS n FROM change_plans').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT status FROM changes WHERE id = ?').get(change?.id)).toEqual({ status: 'processing' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM steps WHERE outcome IS NOT NULL').get()).toEqual({ n: 0 });
  });

  it('does not hold a filing the operator decided without a model: a settled attempt is a read', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(context.place()).toBe(1);
    // The operator's own decision settles the attempt and never stores a model verdict: the
    // guard reads «awaiting a read» from the *open* attempt, not from the missing column, so a
    // human's read is not put back in the queue.
    db.prepare('UPDATE comment_attempts SET verdict = NULL WHERE comment_id = ?').run(id);
    const assignment = context.engine.next({
      for: 'filing',
      session: context.config.session,
    }) as WriterAssignment | null;
    expect(assignment).toMatchObject({ changeId: changeOf(db)?.id });
    expect(assignment?.triage).toEqual({ verdict: null, awaitingRead: false });
  });

  it('invents no verdict from an unreadable stored one: a broken answer is null, not a read', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(context.place()).toBe(1);
    // A row another build wrote, or one edited by hand: no `verdict` word can be read from it.
    // The assignment says so (`null`) instead of guessing `FITS`, and the guard is untouched —
    // the applier owns that defect (`triage.verdict-invalid`), not the patch path.
    db.prepare('UPDATE comment_attempts SET verdict = ? WHERE comment_id = ?').run('{"verdict":"maybe"}', id);
    const assignment = context.engine.next({
      for: 'filing',
      session: context.config.session,
    }) as WriterAssignment | null;
    expect(assignment).toMatchObject({ changeId: changeOf(db)?.id });
    expect(assignment?.triage).toEqual({ verdict: null, awaitingRead: false });
  });
});
