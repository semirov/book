/**
 * BOOK-206 (ADR-045) — every way a filing must **not** move, and why the guard is a row rather
 * than a convention: a settled attempt is not re-placed, a model-named lock is not re-chosen, a
 * recorded verdict is not rewritten by the engine (not only by the writer), a broken call backs
 * off and becomes visible, a paused day buys nothing, and a gate that has not spoken is not this
 * path's to answer.
 */

import { LOCK_LINES, READING_RESCHEDULED_LINE } from '@book/shared';
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
/** The fixture clock starts 2026-10-25 09:00 UTC, so its next midnight is this one. */
const NEXT_UTC_MIDNIGHT = '2026-10-26T00:00:00.000Z';

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
    expect(placed?.reason).toBe(LOCK_LINES.finale);
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

  it('treats a missing gate C column as a defect, once, and stops the loop (BOOK-206 B2)', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    // The gates are not this path's to override: without gate C's column, nothing is placed.
    db.prepare('UPDATE comments SET audit_verdict = NULL WHERE id = ?').run(id);

    for (let tick = 0; tick < 3; tick += 1) expect(context.place()).toBe(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'held', tries: 3 });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.defect'`).get()).toEqual({ n: 1 });
    // The page names the attempt as failed, and the row claims no reading.
    expect(toCommentDto(db, readCommentRow(db, id)!, context.h.clock.ms).attempt).toBe('failed');
  });

  it('does not call an acceptance that wrote nothing a placement (BOOK-206 B2)', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    // A row that already points at a change: `acceptComment` answers with that id and writes
    // nothing at all, so `status` stays `new` and no chain is stored.
    const posted = db.prepare('SELECT block_id, quote, prefix, suffix, base_rev, chapter FROM comments WHERE id = ?').get(id) as {
      block_id: string | null;
      quote: string | null;
      prefix: string | null;
      suffix: string | null;
      base_rev: number | null;
      chapter: number;
    };
    db.prepare(
      `INSERT INTO changes (id, kind, chapter, intent, status, anchor, proposed_text, source_comment,
         source_session, base_rev, base_sha256, base_blocks, scope_hint, premise, enqueued_at)
       VALUES ('chg_legacy_link', 'accepted_comment', ?, 'старое намерение', 'pending', ?, NULL, NULL,
         NULL, ?, '', '[]', 'phrase', 0, ?)`,
    ).run(
      posted.chapter,
      JSON.stringify({ blockIds: posted.block_id === null ? [] : [posted.block_id], quote: posted.quote, prefix: posted.prefix, suffix: posted.suffix }),
      posted.base_rev ?? 1,
      context.h.clock.now().toISOString(),
    );
    db.prepare('UPDATE comments SET change_id = ? WHERE id = ?').run('chg_legacy_link', id);

    const frames: string[] = [];
    const notified: string[] = [];
    const options = {
      db,
      emit: (type: string) => frames.push(type),
      notify: (commentId: string) => notified.push(commentId),
      now: context.h.clock.now,
    };
    expect(placeFiling(options, id)).toBe(false);
    expect(placeFiling(options, id)).toBe(false);
    // Nothing was announced — a push here would say «отклонена» for a filing nobody placed.
    expect(frames).toEqual([]);
    expect(notified).toEqual([]);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'held', tries: 3 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.not-placed'`).get()).toEqual({ n: 1 });
  });

  it('processes a corrupt stored verdict once, and settles it as a defect (BOOK-206 M1)', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    // Not an object at all: `safeJson` gives null, and the row must not be retried every second.
    db.prepare('UPDATE comment_attempts SET verdict = ? WHERE comment_id = ? AND n = 1').run('{not json', id);

    for (let tick = 0; tick < 3; tick += 1) expect(context.place()).toBe(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'held', tries: 3 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.verdict-invalid'`).get()).toEqual({ n: 1 });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
    expect(toCommentDto(db, readCommentRow(db, id)!, context.h.clock.ms).attempt).toBe('failed');
  });
});

describe('a broken call is retried, counted, and shown — never a silent terminal row (BOOK-206)', () => {
  it('backs off by the try, and at the cap gives the attempt the next day instead of a dead row (B5)', async () => {
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
    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]).toMatchObject({ kind: 'triage' });
    expect(context.alerts[0]?.detail).toContain('retry after');
    const failed = db.prepare(`SELECT meta FROM comment_events WHERE type = 'triage.failed'`).all() as Array<{
      meta: string;
    }>;
    expect(failed).toHaveLength(3);
    // The cap is a fact in the event's own meta, so the site's bridge can draw a frame from it.
    expect(JSON.parse(failed[2]!.meta)).toMatchObject({ cap: true, retryAt: NEXT_UTC_MIDNIGHT });
    expect(JSON.parse(failed[0]!.meta).cap).toBeUndefined();

    // B5: not a terminal. The attempt goes back to 00:00 UTC with a fresh budget, and the row's
    // own line names the time — the page never says «остаётся в очереди» about a row `dueTriage`
    // had excluded.
    expect(attemptOf(db, id)).toMatchObject({ tries: 0, verdict: null, claim_until: null, next_at: NEXT_UTC_MIDNIGHT });
    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'new', disposition: null, reason: READING_RESCHEDULED_LINE });
    expect(READING_RESCHEDULED_LINE).toBe('чтение не состоялось — следующая попытка после 00:00 UTC');
    const dto = toCommentDto(db, row, h.clock.ms);
    // «ждёт» with the rescheduled sentence: never the failed state that nothing would retry.
    expect(dto.attempt).toBeNull();
    expect(dto.reason).toBe(READING_RESCHEDULED_LINE);
    expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });

    // No fourth call before midnight, and the next UTC day is the new reading budget.
    const callsBefore = context.calls.length;
    h.clock.advance(6 * 60 * 60_000);
    await context.pulse();
    expect(context.calls).toHaveLength(callsBefore);
    expect(context.alerts).toHaveLength(1);
    h.clock.ms = Date.parse(NEXT_UTC_MIDNIGHT) + 60_000;
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(context.calls).toHaveLength(callsBefore + 1);
    expect(attemptOf(db, id)).toMatchObject({ tries: 1 });
    expect(attemptOf(db, id).verdict).not.toBeNull();
    // The reading happened, so the sentence that named the wait is gone before the placement.
    expect(readCommentRow(db, id)?.reason).toBeNull();
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

describe('a failed call is money too (BOOK-206 M3, AC5)', () => {
  it('charges a call whose answer the engine refused, with the try in the pass id', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    // A well-formed envelope with a reading the parser must refuse: a paper with no carrier.
    context.script.push(
      answerOf({ itemId: id } as Call, 'FITS', { rung: 'through_paper', lock: null, intent: INTENT, carrier: null, refusal: null }),
    );

    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ tries: 1, verdict: null });
    const spend = db.prepare('SELECT pass_id, usd, tokens_in, tokens_out, model FROM pass_spend').all() as Array<
      Record<string, unknown>
    >;
    // One row, keyed by attempt **and try**, priced by the provider's own usage.
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ pass_id: `triage:${id}:1:1` });
    expect(Number(spend[0]?.usd)).toBeGreaterThan(0);
    expect(Number(spend[0]?.tokens_in)).toBeGreaterThan(0);
    // The day's total is the ledger's sum, so the caps see this call.
    const total = db
      .prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM pass_spend WHERE day = ?')
      .get(new Date(context.h.clock.ms).toISOString().slice(0, 10)) as { usd: number };
    expect(total.usd).toBeCloseTo(Number(spend[0]?.usd), 6);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 1 });
  });

  it('names an estimated failed call the pipeline’s estimate, priced all the same (BOOK-219)', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    // The provider reported no usage: the writer read the counts off the text, and a refused
    // answer costs the same estimate as a stored one.
    context.reportUsage({ in: 1_200, out: 300, cachedIn: 0, estimated: true });
    context.script.push(
      answerOf({ itemId: id } as Call, 'FITS', { rung: 'through_paper', lock: null, intent: INTENT, carrier: null, refusal: null }),
    );

    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ tries: 1, verdict: null });
    const spend = db.prepare('SELECT usd, priced, provenance FROM pass_spend').all() as Array<Record<string, unknown>>;
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ priced: 1, provenance: 'pipeline-estimated' });
    expect(Number(spend[0]?.usd)).toBeGreaterThan(0);
  });

  it('charges nothing for a transport failure that reported no usage', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    // The script is empty: the provider throws before any usage exists.
    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ tries: 1, verdict: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 1 });
  });
});
