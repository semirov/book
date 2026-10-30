/**
 * BOOK-206 — the bounds around a claim, and what happens when a process dies inside one.
 *
 * M2: the claim's lease must outlast the **whole** call a writer can make. `provider.ts` retries a
 * broken call once, so one triage call is two call caps; a 600 s lease let a restarted writer buy
 * the same attempt under a live call.
 *
 * M4: a writer killed after `next` leaves `tries` counted and `claim_until` in the past. Every one
 * of those is re-armed by the next tick.
 *
 * The owner's correction of 2026-10-29 («нет, сроков не надо — только конечное количество
 * попыток») replaced the deadline with the counter: six attempts, the third failure widens the
 * reading, the sixth is the engine's own floor rung with no model, and nothing on a clock decides
 * a filing.
 */

import { TRIAGE_REFUSED_LINE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TRIAGE_CALL_TIMEOUT_MS,
  TRIAGE_CLAIM_TTL_MS,
  dueTriage,
  refuseTriage,
} from '../src/comments/triage.ts';
import { readCommentRow } from '../src/comments/repo.ts';
import { INTENT, answerOf, asSaid, attemptOf, bootTriage, type Call, type Context } from './filingTriageHarness.ts';

let context: Context | null = null;

afterEach(async () => {
  await context?.close();
  context = null;
});

/** The ladder a broken provider walks, in the order the engine schedules it. */
const BACKOFFS = [60_000, 5 * 60_000, 20 * 60_000, 40 * 60_000];

async function claim(ctx: Context, session: string, commentId: string): Promise<Record<string, unknown> | undefined> {
  const next = await ctx.client.nextTriage(session);
  const assignment = next.assignment as Record<string, unknown> | null;
  expect(assignment?.commentId).toBe(commentId);
  return assignment ?? undefined;
}

async function fail(ctx: Context, commentId: string, n: number, code = 'PROVIDER_SHAPE'): Promise<unknown> {
  return ctx.client.failTriage({ commentId, n, code });
}

describe('the claim outlives the call it protects (BOOK-206 M2)', () => {
  it('holds the attempt past 601 s and lets it go after the lease', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    // The lease is two call caps plus a margin: one call can be a retry of another.
    expect(TRIAGE_CLAIM_TTL_MS).toBeGreaterThanOrEqual(2 * TRIAGE_CALL_TIMEOUT_MS);
    expect(TRIAGE_CLAIM_TTL_MS).toBeGreaterThan(601_000);

    expect(await claim(context, 'writer-a', id)).toMatchObject({ attempt: 1, tries: 1 });
    const claimRow = attemptOf(db, id);
    expect(claimRow).toMatchObject({ tries: 1, claim_by: 'writer-a' });
    expect(Date.parse(claimRow.claim_until as string) - h.clock.ms).toBe(TRIAGE_CLAIM_TTL_MS);

    // A retried provider call can still be running here: a second writer must buy nothing.
    h.clock.advance(601_000);
    expect((await context.client.nextTriage('writer-b')).assignment).toBeNull();
    expect(attemptOf(db, id)).toMatchObject({ tries: 1, claim_by: 'writer-a' });

    // Past the lease the claim is dead and the attempt is due again — a row is never held forever.
    h.clock.advance(TRIAGE_CLAIM_TTL_MS - 601_000 + 1);
    expect(await claim(context, 'writer-b', id)).toMatchObject({ attempt: 1, tries: 2 });
    expect(attemptOf(db, id)).toMatchObject({ tries: 2, claim_by: 'writer-b' });
  });
});

describe('a claim that expired is re-claimed, never lost (BOOK-206 M4)', () => {
  /** A process killed under the call: the row keeps its try and an expired lease. */
  function crash(ctx: Context, id: string): void {
    ctx.db
      .prepare('UPDATE comment_attempts SET claim_until = ? WHERE comment_id = ? AND n = 1')
      .run(new Date(ctx.h.clock.ms - 1_000).toISOString(), id);
  }

  it('names the abandonment once and widens the reading on the fourth claim', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ proposedText: INTENT });

    for (const tryNo of [1, 2, 3]) {
      await claim(context, `writer-${String(tryNo)}`, id);
      expect(attemptOf(db, id)).toMatchObject({ tries: tryNo });
      crash(context, id);
      h.clock.advance(1_000);
    }
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null });
    // Three claims died; the widening is still a fact of the next claim, which is the fourth try.
    expect(attemptOf(db, id)).toMatchObject({ widened: null });

    const widened = await claim(context, 'writer-4', id);
    expect(widened).toMatchObject({ attempt: 1, tries: 4, of: 6, widened: 'as-document' });
    expect(String(widened?.wideningNote)).toContain('through_paper');
    expect(attemptOf(db, id)).toMatchObject({ tries: 4, widened: 'as-document' });

    // Two crashes are one fact, told once: one marker, one alert, however many ticks follow.
    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]?.detail).toContain('claim-abandoned');
    const abandoned = db.prepare(`SELECT meta FROM comment_events WHERE type = 'triage.abandoned'`).all() as Array<{
      meta: string;
    }>;
    expect(abandoned).toHaveLength(1);
    expect(JSON.parse(abandoned[0]!.meta)).toMatchObject({ attempt: 1, detail: 'claim-abandoned' });
  });

  it('applies the coded floor rung to a row an older build left at the cap, with no model', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post({ proposedText: INTENT });

    // No claim at all and every model try already spent: nothing can run for this row, and the
    // engine's own sixth attempt is the only answer it can still be given.
    db.prepare(`UPDATE comment_attempts SET tries = 5 WHERE comment_id = ?`).run(id);
    await context.pulse();

    expect(context.calls).toHaveLength(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'submitted', tries: 6, desperate: 1, verdict: expect.any(String) });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', audit_verdict: 'FITS' });
    expect(context.alerts).toHaveLength(0);

    // The applier places it at the floor rung: the ladder's «как сказано», decided by code.
    expect(context.place()).toBe(1);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'accepted', disposition: 'as_said' });
  });
});

describe('six attempts decide a read: the third widens, the sixth is desperate (owner, 2026-10-29)', () => {
  it('widens after the third failure, reads 4 and 5 widened, and applies the floor on the sixth', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ proposedText: INTENT });

    // Attempts 1–3 read the filing narrowly: the row still insists on the narrow rung.
    for (const [index, backoff] of BACKOFFS.slice(0, 3).entries()) {
      expect(await claim(context, `writer-${String(index + 1)}`, id)).toMatchObject({
        attempt: 1,
        tries: index + 1,
        of: 6,
        widened: null,
      });
      const result = (await fail(context, id, 1)) as { nextAt: string | null; cap: boolean; desperate?: boolean };
      expect(result).toMatchObject({ cap: false, nextAt: expect.any(String) });
      expect(Date.parse(String(result.nextAt)) - h.clock.ms).toBe(backoff);
      if (index < 2) expect(attemptOf(db, id)).toMatchObject({ widened: null });
      h.clock.advance(backoff + 1);
    }
    // The third failure is where the reading widens, and the row says so before attempt 4.
    expect(attemptOf(db, id)).toMatchObject({ tries: 3, widened: 'as-document', outcome: 'submitted' });
    expect(String(attemptOf(db, id).widening_note)).toContain('through_paper');

    // Attempts 4–5 read under the widening — the assignment itself carries it.
    for (const tryNo of [4, 5]) {
      expect(await claim(context, `writer-${String(tryNo)}`, id)).toMatchObject({ tries: tryNo, widened: 'as-document' });
      const result = (await fail(context, id, 1)) as { cap: boolean; desperate?: boolean };
      if (tryNo === 4) {
        expect(result).toMatchObject({ cap: false, nextAt: expect.any(String) });
        h.clock.advance(BACKOFFS[3]! + 1);
      }
    }

    // The sixth attempt bought no call: the engine applied the floor rung by its own rule.
    expect(context.calls).toHaveLength(0);
    expect(attemptOf(db, id)).toMatchObject({
      outcome: 'submitted',
      tries: 6,
      desperate: 1,
      verdict: expect.any(String),
    });
    expect(context.alerts).toHaveLength(0);
    const note = db.prepare(`SELECT meta FROM comment_events WHERE type = 'triage.desperate'`).get() as {
      meta: string;
    };
    expect(JSON.parse(note.meta)).toMatchObject({ attempt: 1, try: 6, of: 6, rung: 'as_said' });

    // And the applier places the floor reading: accepted at «как сказано», no model anywhere.
    expect(context.place()).toBe(1);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'accepted', disposition: 'as_said' });
    expect(context.frames.map((frame) => frame.type)).toContain('comment:decision');
  });

  it('refuses at the sixth failure when the floor cannot apply, with the sentence, once', async () => {
    context = await bootTriage();
    const { db, h } = context;
    // This wording is an order about the prose itself («сократи… убери…»): the floor's own intent
    // guard refuses it, so «как сказано» cannot be applied and the sixth failure is the refusal.
    const id = await context.post({ proposedText: 'сократи абзац и убери повтор' });

    for (let tryNo = 1; tryNo <= 5; tryNo += 1) {
      await claim(context, `writer-${String(tryNo)}`, id);
      const result = (await fail(context, id, 1)) as { cap: boolean; nextAt: string | null };
      if (tryNo < 5) {
        expect(result).toMatchObject({ cap: false });
        h.clock.advance(BACKOFFS[tryNo - 1]! + 1);
      } else {
        expect(result).toMatchObject({ cap: true, nextAt: null });
      }
    }

    expect(context.calls).toHaveLength(0);
    const row = readCommentRow(db, id);
    expect(row).toMatchObject({ status: 'rejected', disposition: null, reason: TRIAGE_REFUSED_LINE });
    expect(row?.decided_at).not.toBeNull();
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused', tries: 6, desperate: 1, next_at: null, verdict: null });

    // One alert for the operator, one event that names the sixth failure — and neither repeats.
    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]).toMatchObject({ kind: 'triage' });
    const failed = db.prepare(`SELECT meta FROM comment_events WHERE type = 'triage.failed'`).all() as Array<{
      meta: string;
    }>;
    expect(JSON.parse(failed[failed.length - 1]!.meta)).toMatchObject({
      code: 'TRIAGE_DESPERATE',
      attempt: 1,
      try: 6,
      of: 6,
      cap: true,
      desperate: true,
      retryAt: null,
      reason: TRIAGE_REFUSED_LINE,
    });
    const events = failed.length;

    await context.pulse();
    expect(context.alerts).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({
      n: events,
    });
    expect(context.place()).toBe(0);
  });
});

describe('nothing on a clock decides a filing (owner, 2026-10-29)', () => {
  it('leaves an unclaimed filing new however long it sits, and still due', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    // A week with no writer: no sweep, no deadline, no event — the counter has not moved.
    h.clock.advance(7 * 24 * 60 * 60_000);
    await context.pulse();
    // The pulse itself claims the row (a writer is alive again), which is the only thing a tick
    // may do here: it never decides the filing for the clock's sake.
    expect(attemptOf(db, id)).toMatchObject({ tries: 1 });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new' });

    const other = await context.post({ body: 'Второе замечание к тому же абзацу.' });
    expect(dueTriage(db, new Date(h.clock.ms).toISOString())).toEqual([
      expect.objectContaining({ commentId: other }),
    ]);
    expect(readCommentRow(db, other)).toMatchObject({ status: 'new', reason: null });
  });

  it('keeps a live claim: no tick cuts a call that is still running', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    await claim(context, 'writer-late', id);
    h.clock.advance(11 * 60_000);
    await context.pulse();
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', reason: null });
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'submitted', tries: 1, claim_by: 'writer-late' });

    // The lease runs out: the attempt is due again, never refused for the wait.
    h.clock.advance(TRIAGE_CLAIM_TTL_MS);
    expect(await claim(context, 'writer-next', id)).toMatchObject({ tries: 2 });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new' });
    expect(context.alerts).toHaveLength(1);
  });
});

describe('a retried fail report counts nothing twice (BOOK-206 B5)', () => {
  const spend = { model: 'test-model', tokensIn: 10, tokensOut: 5, usd: 0.001 };

  it('moves no attempt that is already answered', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    db.prepare(`UPDATE comment_attempts SET outcome = 'accepted' WHERE comment_id = ?`).run(id);
    expect(refuseTriage(db, { commentId: id, n: 1, at: new Date(h.clock.ms).toISOString() })).toBe(false);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', reason: null, decided_at: null });
  });

  it('does not re-count a try, re-charge it or undo the schedule', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();

    // One broken pulse is one failed try, and the writer's own retry of that report is the same
    // fact: a second event and a second charge would count one call twice.
    await context.pulse();
    expect(await context.client.failTriage({ commentId: id, n: 1, code: 'PROVIDER_TIMEOUT', spend })).toMatchObject({
      already: true,
      cap: false,
      tries: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
    expect(attemptOf(db, id)).toMatchObject({ tries: 1 });
  });

  it('a report retried after the refusal keeps the filing refused, with no second alert', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ proposedText: 'сократи абзац и убери повтор' });
    for (let tryNo = 1; tryNo <= 5; tryNo += 1) {
      await claim(context, `writer-${String(tryNo)}`, id);
      await fail(context, id, 1);
      if (tryNo < 5) h.clock.advance(BACKOFFS[tryNo - 1]! + 1);
    }
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused' });

    expect(await context.client.failTriage({ commentId: id, n: 1, code: 'PROVIDER_TIMEOUT', spend })).toMatchObject({
      already: true,
      cap: true,
      nextAt: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected', reason: TRIAGE_REFUSED_LINE });
    expect(context.alerts).toHaveLength(1);
  });

  /** A verdict that arrives after the refusal is a late answer, never a second decision. */
  it('drops a verdict the engine no longer has an open attempt for', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ proposedText: 'сократи абзац и убери повтор' });
    for (let tryNo = 1; tryNo <= 5; tryNo += 1) {
      await claim(context, `writer-${String(tryNo)}`, id);
      await fail(context, id, 1);
      if (tryNo < 5) h.clock.advance(BACKOFFS[tryNo - 1]! + 1);
    }
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected' });

    expect(
      await context.client.verdictTriage({
        commentId: id,
        n: 1,
        verdict: answerOf({ itemId: id } as Call, 'FITS', asSaid()),
        spend: { model: 'test-model', tokensIn: 10, tokensOut: 5, usd: 0.001 },
      }),
    ).toEqual({ stored: false, already: true });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected', audit_verdict: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
  });
});
