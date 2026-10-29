/**
 * BOOK-206 (ADR-045) — the chain that makes a filing move by itself, proven end to end: the site
 * posts it, the engine claims it out of its own ledger, a **scripted** model reads it, the engine
 * stores the one verdict, the site's applier places the reading, and the lane can claim the
 * change. No CLI, no person, no network.
 *
 * The provider is scripted for the same reason the gate tests script it: the protocol under test
 * is the container's, and a real model answer is not what a test can assert. Every seam is the
 * production one: a real `POST /api/comments`, a real `createEngine` over the same database, a
 * real `buildControl` reached through the writer's own `createEngineClient` (its documented
 * `fetch` seam), and real rows. The seams live in `filingTriageHarness.ts`; the ways a filing
 * must **not** move live in `filingTriageGuards.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow } from '../src/comments/repo.ts';
import { migrateV30 } from '../src/db/migrateV30.ts';
import { runFeedback } from '../src/feedback/cli.ts';
import { placeFiling } from '../src/feedback/triageApplier.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BLOCK_TEXT,
  INTENT,
  answerOf,
  asSaid,
  attemptOf,
  bootTriage,
  changeOf,
  seedEscalated,
  unlicensedPaper,
  type Call,
  type Context,
} from './filingTriageHarness.ts';

let context: Context | null = null;

afterEach(async () => {
  await context?.close();
  context = null;
});

describe('a filing moves by itself (BOOK-206)', () => {
  it('post → claim → one scripted read → stored verdict → placed rung → a pending change', async () => {
    context = await bootTriage();
    const { db } = context;

    // (1) The posting request writes the comment and its own attempt, and nothing else.
    const id = await context.post();
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null, audit_verdict: null });
    expect(attemptOf(db, id)).toMatchObject({ n: 1, outcome: 'submitted', tries: 0, verdict: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });

    // (2) The pulse: exactly one envelope, the filing's own id, and the world it is judged against.
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(context.calls).toHaveLength(1);
    const call = context.calls[0]!;
    expect(call.itemId).toBe(id);
    expect(call.world).toContain(BLOCK_TEXT);
    expect(call.user).toContain('<<<DATA triage:' + id + '>>>');
    expect(call.system).toContain('AUDITOR');
    expect(context.frames).toEqual([]);

    // (3) One verdict on the attempt, gate C's own columns, one money row.
    expect(attemptOf(db, id).verdict).not.toBeNull();
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', audit_verdict: 'FITS', audit_reason: null });
    const spend = db.prepare(`SELECT pass, pass_id, usd, priced FROM pass_spend`).all() as Array<Record<string, unknown>>;
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ pass: 'triage', pass_id: `triage:${id}:1` });
    expect(Number(spend[0]?.usd)).toBeGreaterThan(0);

    // (4) A second pulse asks nothing: a stored verdict is never re-judged.
    await context.pulse();
    expect(context.calls).toHaveLength(1);

    // (5) The applier places the reading: a rung, the decision, a `pending` change, a closed attempt.
    expect(context.place()).toBe(1);
    const placed = readCommentRow(db, id);
    expect(placed).toMatchObject({ status: 'accepted', disposition: 'as_said', lock: null, carrier_kind: null });
    expect(placed?.decided_at).not.toBeNull();
    const change = changeOf(db);
    expect(change).toMatchObject({ status: 'pending', kind: 'accepted_comment', source_comment: id, intent: INTENT });
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'accepted' });
    expect(context.frames.filter((frame) => frame.type === 'comment:decision')).toHaveLength(1);
    expect(context.frames[0]?.data).toMatchObject({ id, status: 'accepted', changeId: change?.id });

    // (6) The writer's own lane can claim it.
    const assignment = context.engine.next({ for: 'filing', session: 'writer-triage-test' });
    expect(assignment).toMatchObject({ changeId: change?.id, chapter: 8 });

    // (7) A second poll changes nothing at all.
    expect(context.place()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM comment_events WHERE type = ?').get('decided')).toEqual({ n: 1 });
  });

  it('an OFF filing whose paper cannot be licensed still lands on the as_said floor — never escalated', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'OFF', unlicensedPaper()));

    await context.pulse();
    expect(readCommentRow(db, id)).toMatchObject({
      audit_verdict: 'OFF',
      audit_reason: 'вне книги: бумага не меняет ни одного факта',
    });
    expect(context.place()).toBe(1);

    const placed = readCommentRow(db, id);
    // The ladder is total (ADR-045 §5): a failed carrier falls one rung up, and the floor answers.
    expect(placed).toMatchObject({ status: 'accepted', disposition: 'as_said', carrier_kind: null, lock: null });
    expect(changeOf(db)).toMatchObject({ status: 'pending', source_comment: id });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE status = 'escalated' OR disposition = 'escalated'`).get(),
    ).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE status = 'rejected'`).get()).toEqual({ n: 0 });
  });

  it('reads a filing shorter than the quote bound: its whole text is the checkable quote', async () => {
    context = await bootTriage();
    const { db } = context;
    // «он чихнул» normalises to nine characters — the owner's filing is exactly this shape, and
    // before BOOK-206's probe finding every answer that quoted it failed the post-check.
    const id = await context.post({ body: 'он чихнул' });
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid(), [{ field: 'text', quote: 'он чихнул' }]));

    await context.pulse();
    expect(attemptOf(db, id).verdict).not.toBeNull();
    expect(readCommentRow(db, id)).toMatchObject({ audit_verdict: 'FITS' });

    expect(context.place()).toBe(1);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'accepted', disposition: 'as_said' });
    expect(changeOf(db)).toMatchObject({ status: 'pending', source_comment: id });
  });

  it('re-opens an escalated row: the reading is asked, the stored OFF is never rewritten', async () => {
    context = await bootTriage();
    const { db, h } = context;

    // The owner's row shape (BOOK-206 AC8): a filing the ladder once parked for a person.
    const owner = 'cmt_01M635KZP466CGBC0CKS1NWS4Z';
    seedEscalated(context, owner);

    // An old door could leave a link behind: the receipt and the change must not survive the
    // re-open, or `acceptComment` would no-op over a change nobody placed (BOOK-206 B2).
    db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, status, anchor, proposed_text, source_comment,
         source_session, base_rev, base_sha256, base_blocks, scope_hint, premise, enqueued_at)
       VALUES ('chg_stale_link', 'accepted_comment', 8, 'старое намерение', 'pending', NULL, NULL, NULL,
         NULL, 1, '', '[]', 'phrase', 0, ?)`,
    ).run(new Date(h.clock.ms).toISOString());
    db.prepare(`UPDATE comments SET change_id = 'chg_stale_link', applied_chapter = 8, applied_rev = 1 WHERE id = ?`).run(owner);

    // The v30 step re-opens it and arms one submitted attempt — no id is special-cased anywhere.
    migrateV30(db);
    expect(readCommentRow(db, owner)).toMatchObject({ change_id: null, applied_chapter: null, applied_rev: null });
    expect(readCommentRow(db, owner)).toMatchObject({
      status: 'new',
      disposition: null,
      decided_at: null,
      reason: null,
      audit_verdict: 'OFF',
    });
    // `n = max+1` of a submission that is still waiting: the held answer is history, not a trigger.
    expect(attemptOf(db, owner, 2)).toMatchObject({ n: 2, outcome: 'submitted', tries: 0, verdict: null });
    expect(attemptOf(db, owner, 1)).toMatchObject({ outcome: 'held' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE comment_id = ? AND type = 'reopened'`).get(owner)).toEqual({
      n: 1,
    });
    // Idempotent: a second run changes nothing (the WHERE no longer matches).
    migrateV30(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM comment_attempts WHERE comment_id = ?').get(owner)).toEqual({ n: 2 });

    context.script.push(answerOf({ itemId: owner } as Call, 'OFF', unlicensedPaper()));
    await context.pulse();
    expect(context.calls).toHaveLength(1);
    // The recorded verdict travels in the ask and the prompt says so in words.
    expect(context.calls[0]?.user).toContain('<<<DATA triage:' + owner + '>>>');
    expect(context.calls[0]?.system).toContain('Вердикт уже вынесен: OFF; верни только чтение');
    expect(readCommentRow(db, owner)?.audit_verdict).toBe('OFF');

    expect(context.place()).toBe(1);
    expect(readCommentRow(db, owner)).toMatchObject({
      status: 'accepted',
      disposition: 'as_said',
      audit_verdict: 'OFF',
    });
    // The new change is the one this filing names; the stale link is history and was cleared.
    expect(db.prepare('SELECT status, source_comment FROM changes WHERE source_comment = ?').get(owner)).toEqual({
      status: 'pending',
      source_comment: owner,
    });
  });
});

describe('the rights door comes before the model (BOOK-61, BOOK-206 B1)', () => {
  it('buys no read for a filing Gate B has not cleared, and places it once the verdict lands', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    // Gate B has not spoken: a flagged filing waits on the operator's surface, and no model is
    // paid for it.
    h.db.prepare(`UPDATE comments SET rights_verdict = NULL WHERE id = ?`).run(id);
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));

    await context.pulse();
    expect(context.calls).toHaveLength(0);
    expect(attemptOf(db, id)).toMatchObject({ tries: 0, verdict: null });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', audit_verdict: null });

    // The clearance is recorded and the very next tick reads it.
    const dir = mkdtempSync(join(tmpdir(), 'book-triage-rights-'));
    try {
      expect(runFeedback(['rights', id, '--verdict', 'CLEAR'], { db, dir, now: h.clock.now, print: () => {} })).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(readCommentRow(db, id)).toMatchObject({ rights_verdict: 'CLEAR' });

    await context.pulse();
    expect(context.calls).toHaveLength(1);
    expect(attemptOf(db, id).verdict).not.toBeNull();
    expect(context.place()).toBe(1);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'accepted', disposition: 'as_said' });
    expect(changeOf(db)).toMatchObject({ status: 'pending', source_comment: id });
  });

  it('parks a row whose reading arrives before the clearance, with one event per attempt', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    // The verdict is stored; the clearance is then withdrawn (a race the production path has:
    // a row is re-opened by `release` while a reading waits, and its verdict is cleared).
    h.db.prepare(`UPDATE comments SET rights_verdict = NULL WHERE id = ?`).run(id);

    // The query asks for CLEAR, so this is the race the guard exists for: the applier is asked
    // about a row whose clearance vanished between the read and the write.
    const options = { db, emit: () => {}, notify: () => {}, now: h.clock.now };
    for (let tick = 0; tick < 3; tick += 1) {
      expect(placeFiling(options, id)).toBe(false);
    }
    const waiting = db
      .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.waiting-gate'`)
      .all(id) as Array<{ meta: string }>;
    expect(waiting).toHaveLength(1);
    expect(JSON.parse(waiting[0]!.meta)).toMatchObject({ code: 'RIGHTS_REQUIRED', attempt: 1 });
    // The attempt stays open for the clearance, and the row is parked six hours ahead.
    const parked = attemptOf(db, id);
    expect(parked).toMatchObject({ outcome: 'submitted' });
    expect(Date.parse(parked.next_at as string) - h.clock.ms).toBe(6 * 60 * 60_000);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
  });
});
