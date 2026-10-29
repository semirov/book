/**
 * BOOK-206 (ADR-045) — every way a filing must **not** move, and why the guard is a row rather
 * than a convention: a settled attempt is not re-placed, a model-named lock is not re-chosen, a
 * recorded verdict is not rewritten by the engine (not only by the writer), a broken call backs
 * off and becomes visible, a paused day buys nothing, and a gate that has not spoken is not this
 * path's to answer.
 */

import { LOCK_REASONS } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { readCommentRow, toCommentDto } from '../src/comments/repo.ts';
import { migrateV30 } from '../src/db/migrateV30.ts';
import { placeFiling } from '../src/feedback/triageApplier.ts';
import {
  INTENT,
  answerOf,
  asSaid,
  attemptOf,
  bootTriage,
  seedEscalated,
  type Call,
  type Context,
} from './filingTriageHarness.ts';

let context: Context | null = null;

afterEach(async () => {
  await context?.close();
  context = null;
});

const OWNER = 'cmt_01M635KZP466CGBC0CKS1NWS4Z';

describe('the applier never guesses (BOOK-206)', () => {
  it('does not re-process a settled attempt: a corrupt stored verdict is recorded once', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    // A row written by another build (or edited by hand): the reading is not trusted on faith.
    db.prepare('UPDATE comment_attempts SET verdict = ? WHERE comment_id = ? AND n = 1').run(
      JSON.stringify({ verdict: 'FITS', reading: { rung: 'through_paper', intent: INTENT } }),
      id,
    );

    const options = { db, emit: () => {}, notify: () => {}, now: context.h.clock.now };
    expect(context.place()).toBe(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'held' });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.verdict-invalid'`).get()).toEqual({
      n: 1,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });

    // The attempt is settled, so the next tick must not pick it again: no placement, no event.
    expect(placeFiling(options, id)).toBe(false);
    expect(context.place()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.verdict-invalid'`).get()).toEqual({
      n: 1,
    });
  });

  it('a model-named finale lock is refused under its own clause, never escalated', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(
      answerOf({ itemId: id } as Call, 'OFF', {
        rung: 'inadmissible',
        lock: 'finale',
        intent: INTENT,
        carrier: null,
        refusal: null,
      }),
    );

    await context.pulse();
    expect(context.place()).toBe(1);

    const placed = readCommentRow(db, id);
    expect(placed).toMatchObject({ status: 'rejected', disposition: 'inadmissible', lock: 'finale', change_id: null });
    // The reader is owed the lock's own closed clause, never the author's question.
    expect(placed?.reason).toBe(LOCK_REASONS.finale);
    expect(placed?.reason).not.toBe('можно ли оформить это бумагой?');
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE status = 'escalated' OR disposition = 'escalated'`).get(),
    ).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'escalated'`).get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused' });
  });

  it('the engine refuses an answer that rewrites a recorded verdict, and stores nothing', async () => {
    context = await bootTriage();
    const { db } = context;
    seedEscalated(context, OWNER);
    migrateV30(db);
    expect(readCommentRow(db, OWNER)?.audit_verdict).toBe('OFF');

    // The writer's guard is a courtesy; the row is the authority. A direct caller that answers
    // FITS for a filing gate C already read as OFF is refused by the engine itself.
    const client = context.client;
    await expect(
      client.verdictTriage({
        commentId: OWNER,
        n: 2,
        verdict: answerOf({ itemId: OWNER } as Call, 'FITS', asSaid()),
        spend: { model: context.config.apiModel, tokensIn: 1200, tokensOut: 300, usd: 0.001 },
      }),
    ).rejects.toMatchObject({ code: 'VERDICT_LOCKED' });

    expect(attemptOf(db, OWNER, 2)).toMatchObject({ outcome: 'submitted', verdict: null });
    expect(readCommentRow(db, OWNER)?.audit_verdict).toBe('OFF');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
  });

  it('does not place a filing a gate has not cleared', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    // The gates are not this path's to override: without gate C's column, nothing is placed.
    db.prepare('UPDATE comments SET audit_verdict = NULL WHERE id = ?').run(id);

    expect(context.place()).toBe(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'held' });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.not-placed'`).get()).toEqual({ n: 1 });
  });
});

describe('a broken call is retried, counted, and shown — never a silent terminal row (BOOK-206)', () => {
  it('backs off by the try, raises one alert at the cap, and the page says the attempt failed', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    // The script is empty: every pulse is a broken call, which is exactly the case to bound.
    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'submitted', tries: 1, verdict: null });
    expect(Date.parse(attemptOf(db, id).next_at as string) - h.clock.ms).toBe(60_000);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 1 });

    // The second try waits ten minutes, and the third is the cap.
    h.clock.advance(60_001);
    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ tries: 2 });
    expect(Date.parse(attemptOf(db, id).next_at as string) - h.clock.ms).toBe(600_000);
    h.clock.advance(600_001);
    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ tries: 3, verdict: null });
    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]).toMatchObject({ kind: 'triage' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 3 });

    // No fourth call, no disposition, no change: the row stays `new`, and the page names the
    // attempt as failed instead of waiting forever.
    const callsBefore = context.calls.length;
    h.clock.advance(6 * 60 * 60_000 + 1);
    await context.pulse();
    expect(context.calls).toHaveLength(callsBefore);
    expect(context.alerts).toHaveLength(1);
    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'new', disposition: null, decided_at: null });
    expect(toCommentDto(db, row, h.clock.ms).attempt).toBe('failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });
  });

  it('a paused day hands out nothing and touches no row', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    const day = new Date(h.clock.ms).toISOString().slice(0, 10);
    // The day's cap is spent: the engine's own guard is the authority, not the writer's check.
    db.prepare(
      `INSERT INTO pass_spend (at, day, pass_id, chapter, pass, change_id, model, tokens_in, tokens_out, usd, priced)
       VALUES (?, ?, 'pass_spent', 8, 'change', NULL, NULL, 0, 0, 10, 1)`,
    ).run(new Date(h.clock.ms).toISOString(), day);

    expect(await context.client.nextTriage('writer-triage-test')).toEqual({ assignment: null, reason: 'budget' });
    await context.pulse();
    expect(context.calls).toHaveLength(0);
    expect(attemptOf(db, id)).toMatchObject({ tries: 0, claim_by: null, next_at: null });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
  });
});
