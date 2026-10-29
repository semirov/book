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

  it('re-opens an escalated row: the reading is asked, the stored OFF is never rewritten', async () => {
    context = await bootTriage();
    const { db } = context;

    // The owner's row shape (BOOK-206 AC8): a filing the ladder once parked for a person.
    const owner = 'cmt_01M635KZP466CGBC0CKS1NWS4Z';
    seedEscalated(context, owner);

    // The v30 step re-opens it and arms one submitted attempt — no id is special-cased anywhere.
    migrateV30(db);
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
    expect(changeOf(db)).toMatchObject({ status: 'pending', source_comment: owner });
  });
});
