/**
 * BOOK-206 — the two bounds around a claim, and what happens when a process dies inside one.
 *
 * M2: the claim's lease must outlast the **whole** call a writer can make. `provider.ts` retries a
 * broken call once, so one triage call is two call caps; a 600 s lease let a restarted writer buy
 * the same attempt under a live call.
 *
 * M4: a writer killed after `next` leaves `tries` counted and `claim_until` in the past. Three of
 * those used to kill the row with no `fail`, no alert and no way back into `dueTriage`. The engine
 * now names it once (`triage.abandoned`, one operator alert per attempt) and gives the attempt the
 * next day, exactly as the cap does.
 */

import { READING_RESCHEDULED_LINE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  TRIAGE_BACKOFF_MS,
  TRIAGE_CALL_TIMEOUT_MS,
  TRIAGE_CLAIM_TTL_MS,
  TRIAGE_MAX_TRIES,
  rescheduleTomorrow,
} from '../src/comments/attempts.ts';
import { readCommentRow, toCommentDto } from '../src/comments/repo.ts';
import { EngineBridge } from '../src/engineState/bridge.ts';
import { answerOf, asSaid, attemptOf, bootTriage, type Call, type Context } from './filingTriageHarness.ts';

let context: Context | null = null;

afterEach(async () => {
  await context?.close();
  context = null;
});

/** The fixture clock starts 2026-10-25 09:00 UTC, so its next midnight is this one. */
const NEXT_UTC_MIDNIGHT = '2026-10-26T00:00:00.000Z';

describe('the claim outlives the call it protects (BOOK-206 M2)', () => {
  it('holds the attempt past 601 s and lets it go after the lease', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    // The lease is two call caps plus a margin: one call can be a retry of another.
    expect(TRIAGE_CLAIM_TTL_MS).toBeGreaterThanOrEqual(2 * TRIAGE_CALL_TIMEOUT_MS);
    expect(TRIAGE_CLAIM_TTL_MS).toBeGreaterThan(601_000);

    expect((await context.client.nextTriage('writer-a')).assignment).toMatchObject({ commentId: id, attempt: 1 });
    const claim = attemptOf(db, id);
    expect(claim).toMatchObject({ tries: 1, claim_by: 'writer-a' });
    expect(Date.parse(claim.claim_until as string) - h.clock.ms).toBe(TRIAGE_CLAIM_TTL_MS);

    // A retried provider call can still be running here: a second writer must buy nothing.
    h.clock.advance(601_000);
    expect((await context.client.nextTriage('writer-b')).assignment).toBeNull();
    expect(attemptOf(db, id)).toMatchObject({ tries: 1, claim_by: 'writer-a' });

    // Past the lease the claim is dead and the attempt is due again — a row is never held forever.
    h.clock.advance(TRIAGE_CLAIM_TTL_MS - 601_000 + 1);
    expect((await context.client.nextTriage('writer-b')).assignment).toMatchObject({ commentId: id, attempt: 1 });
    expect(attemptOf(db, id)).toMatchObject({ tries: 2, claim_by: 'writer-b' });
  });
});

describe('a claim abandoned by a crash is named, once (BOOK-206 M4)', () => {
  it('three expired claims raise exactly one alert and give the attempt the next day', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    // Five claims (the ladder's ceiling), each outliving its writer: no `fail` is ever called.
    for (let claim = 0; claim < TRIAGE_MAX_TRIES; claim += 1) {
      expect((await context.client.nextTriage(`writer-${String(claim)}`)).assignment).toMatchObject({ commentId: id, attempt: 1 });
      h.clock.advance(TRIAGE_CLAIM_TTL_MS + 1);
    }
    expect(attemptOf(db, id)).toMatchObject({ tries: TRIAGE_MAX_TRIES });

    // One more pulse: the row is capped and nobody called `fail` — the sweep settles it.
    expect((await context.client.nextTriage('writer-after')).assignment).toBeNull();

    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]).toMatchObject({ kind: 'triage' });
    expect(context.alerts[0]?.detail).toContain('claim-abandoned');
    const abandoned = db.prepare(`SELECT meta FROM comment_events WHERE type = 'triage.abandoned'`).all() as Array<{
      meta: string;
    }>;
    expect(abandoned).toHaveLength(1);
    expect(JSON.parse(abandoned[0]!.meta)).toMatchObject({ attempt: 1 });

    // The cap's behaviour applies, not a dead row: one new day, one fresh budget, the sentence.
    expect(attemptOf(db, id)).toMatchObject({ tries: 0, claim_until: null, claim_by: null, next_at: NEXT_UTC_MIDNIGHT });
    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'new', disposition: null, reason: READING_RESCHEDULED_LINE, decided_at: null });
    expect(toCommentDto(db, row, h.clock.ms).attempt).toBeNull();

    // And it is not re-alerted: a 5 s cadence must not turn one fact into a stream of rows.
    expect((await context.client.nextTriage('writer-after')).assignment).toBeNull();
    expect(context.alerts).toHaveLength(1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.abandoned'`).get()).toEqual({
      n: 1,
    });
  });

  it('reads the filing again after the midnight it was given', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    for (let claim = 0; claim < TRIAGE_MAX_TRIES; claim += 1) {
      await context.client.nextTriage(`writer-${String(claim)}`);
      h.clock.advance(TRIAGE_CLAIM_TTL_MS + 1);
    }
    await context.client.nextTriage('writer-after');
    expect(attemptOf(db, id)).toMatchObject({ tries: 0, next_at: NEXT_UTC_MIDNIGHT });

    h.clock.ms = Date.parse(NEXT_UTC_MIDNIGHT) + 1_000;
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    expect(context.calls).toHaveLength(1);
    expect(attemptOf(db, id)).toMatchObject({ tries: 1 });
    expect(attemptOf(db, id).verdict).not.toBeNull();
  });
});

describe('a retried fail report counts nothing twice (BOOK-206 B5)', () => {
  const spend = { model: 'test-model', tokensIn: 10, tokensOut: 5, usd: 0.001 };

  it('moves no attempt that is already answered', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    db.prepare(`UPDATE comment_attempts SET outcome = 'accepted' WHERE comment_id = ?`).run(id);
    expect(rescheduleTomorrow(db, { commentId: id, n: 1, nowMs: h.clock.ms })).toBeNull();
    expect(readCommentRow(db, id)?.reason).toBeNull();
  });

  it('does not re-count a try, re-charge it or undo the cap', async () => {
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

  it('a report retried after the cap leaves the attempt on its next day, with no second charge', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();
    // §10.8: five bought calls, each after its own backoff; the fifth is the cap.
    await context.pulse();
    for (const backoff of TRIAGE_BACKOFF_MS) {
      h.clock.advance(backoff + 1);
      await context.pulse();
    }
    expect(attemptOf(db, id)).toMatchObject({
      tries: TRIAGE_MAX_TRIES,
      next_at: null,
      desperate: 1,
      claim_until: null,
    });

    // A report retried after the cap is the same fifth failure: no second event, no new wait.
    expect(await context.client.failTriage({ commentId: id, n: 1, code: 'PROVIDER_TIMEOUT', spend })).toMatchObject({
      already: true,
      cap: true,
      nextAt: null,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({
      n: TRIAGE_MAX_TRIES,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pass_spend').get()).toEqual({ n: 0 });
    expect(attemptOf(db, id)).toMatchObject({ tries: TRIAGE_MAX_TRIES, next_at: null, desperate: 1 });
    expect(context.alerts).toHaveLength(1);
  });
});

describe('§10.8 — the reading ladder', () => {
  it('widens at the third failure, marks the desperate sixth and settles it', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post();

    // Three broken calls: 60 s, then 10 min, then the widening.
    await context.pulse();
    h.clock.advance(TRIAGE_BACKOFF_MS[0]! + 1);
    await context.pulse();
    h.clock.advance(TRIAGE_BACKOFF_MS[1]! + 1);
    await context.pulse();

    expect(attemptOf(db, id)).toMatchObject({ tries: 3, widened: 'as-document' });
    const widened = db
      .prepare(`SELECT meta FROM comment_events WHERE comment_id = ? AND type = 'triage.widened'`)
      .all(id) as Array<{ meta: string }>;
    expect(widened).toHaveLength(1);
    expect(JSON.parse(widened[0]!.meta)).toMatchObject({ widened: 'as-document', try: 3 });

    // Attempt 4 is read under the widened requirement, after the 6 h rung it waits on.
    h.clock.advance(TRIAGE_BACKOFF_MS[2]! + 1);
    const fourth = await context.client.nextTriage('writer-4');
    expect(fourth.assignment).toMatchObject({ commentId: id, attempt: 1, widened: 'as-document' });
    await context.client.failTriage({ commentId: id, n: 1, code: 'PROVIDER_SHAPE' });

    // Attempt 5 is the last bought call; its failure hands over to the desperate sixth.
    h.clock.advance(TRIAGE_BACKOFF_MS[3]! + 1);
    const fifth = await context.client.nextTriage('writer-5');
    expect(fifth.assignment).not.toBeNull();
    expect(await context.client.failTriage({ commentId: id, n: 1, code: 'PROVIDER_TIMEOUT' })).toMatchObject({
      cap: true,
      desperate: true,
      nextAt: null,
    });
    expect(attemptOf(db, id)).toMatchObject({ tries: 5, desperate: 1, next_at: null });

    // The site settles the sixth without a model call: a visible defect, one frame, no loop.
    expect(context.place()).toBe(1);
    expect(attemptOf(db, id)).toMatchObject({ tries: 6, outcome: 'held', desperate: 1 });
    expect(context.place()).toBe(0);

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const bridge = new EngineBridge({
      db,
      emit: (type, data) => frames.push({ type, data: data as Record<string, unknown> }),
      replay: true,
      progressThrottleMs: 0,
      now: () => h.clock.ms,
    });
    bridge.prime();
    bridge.tick();
    const reading = frames.filter((frame) => frame.type === 'filing:reading').at(-1)?.data;
    expect(reading).toMatchObject({ commentId: id, phase: 'failed', attempt: 6, maxAttempts: 6, desperate: true });
  });
});
