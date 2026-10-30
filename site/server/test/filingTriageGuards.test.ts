/**
 * BOOK-206 (ADR-045) — every way a filing must **not** move, and why the guard is a row rather
 * than a convention: a settled attempt is not re-placed, a model-named lock is not re-chosen, a
 * recorded verdict is not rewritten by the engine (not only by the writer), a broken call backs
 * off and becomes visible, a paused day buys nothing, and a gate that has not spoken is not this
 * path's to answer.
 */

import { HARM_LOCK_LINES, LOCK_LINES, OUR_FAILURE_LINE, TRIAGE_REFUSED_LINE } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { TRIAGE_BACKOFF_MS, TRIAGE_MAX_TRIES, dueTriage } from '../src/comments/triage.ts';
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

  it('places a held answer once it is readable again, instead of refusing a placeable row', async () => {
    context = await bootTriage();
    const { db } = context;
    const id = await context.post();
    context.script.push(answerOf({ itemId: id } as Call, 'FITS', asSaid()));
    await context.pulse();
    const stored = attemptOf(db, id).verdict;
    expect(typeof stored).toBe('string');

    // A broken answer is held at the cap; the next tick asks it once more.
    db.prepare('UPDATE comment_attempts SET verdict = ? WHERE comment_id = ? AND n = 1').run('{not json', id);
    expect(context.place()).toBe(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'held', tries: TRIAGE_MAX_TRIES });

    // The row is readable again (a later build, an operator's repair): the recovery places it.
    db.prepare('UPDATE comment_attempts SET verdict = ? WHERE comment_id = ? AND n = 1').run(String(stored), id);
    expect(context.place()).toBe(1);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'accepted' });
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'accepted' });
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

    // The first tick holds the answer, the second asks it once more, and the second failure is
    // the refusal sink: an answer the applier cannot place never waits on the page as «ждёт».
    for (let tick = 0; tick < 3; tick += 1) expect(context.place()).toBe(0);
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused', tries: TRIAGE_MAX_TRIES });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected', reason: OUR_FAILURE_LINE });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.defect'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 1 });
    // The page offers the retry, because the failure was ours and the idea was not judged.
    const dto = toCommentDto(db, readCommentRow(db, id)!, context.h.clock.ms);
    expect(dto).toMatchObject({ status: 'rejected', reason: OUR_FAILURE_LINE, retryable: true });
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
    // Nothing was announced as a placement — a push here would say «принята» for a filing the
    // applier could not place. The second failure is the refusal sink, in our own words.
    expect(frames).toEqual([]);
    expect(notified).toEqual([]);
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected', reason: OUR_FAILURE_LINE });
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused', tries: TRIAGE_MAX_TRIES });
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
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused', tries: TRIAGE_MAX_TRIES });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.verdict-invalid'`).get()).toEqual({ n: 1 });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'rejected', reason: OUR_FAILURE_LINE });
    const dto = toCommentDto(db, readCommentRow(db, id)!, context.h.clock.ms);
    expect(dto).toMatchObject({ status: 'rejected', retryable: true });
  });
});

describe('a broken call is retried, counted, and corrected by the schedule — never a silent row (BOOK-206)', () => {
  /** The ladder a broken provider walks, in the order the engine schedules it. */
  const BACKOFFS = [60_000, 5 * 60_000, 20 * 60_000, 40 * 60_000];

  it('backs off by the try, and the sixth attempt needs no model at all', async () => {
    context = await bootTriage();
    const { db, h } = context;
    // The floor's own intent must be a sentence the chapter accepts: this one is.
    const id = await context.post({ proposedText: INTENT });

    // The script is empty: every pulse is a broken call, which is exactly the case to bound.
    await context.pulse();
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'submitted', tries: 1, verdict: null });
    expect(Date.parse(attemptOf(db, id).next_at as string) - h.clock.ms).toBe(60_000);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 1 });

    // The ladder is 60 s → 5 min → 20 min → 40 min between model calls.
    expect(TRIAGE_BACKOFF_MS).toEqual(BACKOFFS);

    for (const [index, backoff] of BACKOFFS.entries()) {
      h.clock.advance(backoff + 1);
      await context.pulse();
      if (index < 2) {
        expect(attemptOf(db, id)).toMatchObject({ tries: index + 2 });
        expect(Date.parse(attemptOf(db, id).next_at as string) - h.clock.ms).toBe(BACKOFFS[index + 1]);
      }
    }

    // Five model calls, then the engine's own sixth attempt: the floor rung, no call bought.
    expect(context.calls).toHaveLength(TRIAGE_MAX_TRIES - 1);
    expect(attemptOf(db, id)).toMatchObject({ tries: TRIAGE_MAX_TRIES, desperate: 1, verdict: expect.any(String) });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', audit_verdict: 'FITS' });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.desperate'`).get()).toEqual({
      n: 1,
    });

    // The applier places it, and the record leaves every queue: no field of the page promises a wait.
    expect(context.place()).toBe(1);
    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'accepted', disposition: 'as_said' });
    expect(dueTriage(db, new Date(h.clock.ms + 24 * 60 * 60_000).toISOString())).toEqual([]);
    const dto = toCommentDto(db, row, h.clock.ms);
    expect(JSON.stringify(dto)).not.toContain('в очереди');
    expect(JSON.stringify(dto)).not.toContain('ждёт');

    // Nothing retries it: no tick, no applier, no model — the row is decided for good.
    const callsBefore = context.calls.length;
    h.clock.advance(6 * 60 * 60_000);
    await context.pulse();
    expect(context.calls).toHaveLength(callsBefore);
    expect(context.place()).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM comment_events WHERE type = 'triage.failed'`).get()).toEqual({ n: 5 });
  });

  it('refuses a filing whose floor cannot apply, with the one sentence and one alert', async () => {
    context = await bootTriage();
    const { db, h } = context;
    // An order about the prose itself: the floor's intent guard refuses it, so the sixth failure
    // is the refusal — once, both for the page and for the operator.
    const id = await context.post({ proposedText: 'сократи абзац и убери повтор' });

    for (let tryNo = 1; tryNo <= BACKOFFS.length + 1; tryNo += 1) {
      await context.pulse();
      if (tryNo <= BACKOFFS.length) h.clock.advance(BACKOFFS[tryNo - 1]! + 1);
    }

    expect(context.calls).toHaveLength(TRIAGE_MAX_TRIES - 1);
    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'rejected', disposition: null, reason: TRIAGE_REFUSED_LINE });
    expect(row.decided_at).not.toBeNull();
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused', desperate: 1, next_at: null });
    expect(context.alerts).toHaveLength(1);
    expect(context.alerts[0]).toMatchObject({ kind: 'triage' });
    const dto = toCommentDto(db, row, h.clock.ms);
    expect(dto.reason).toBe(TRIAGE_REFUSED_LINE);
    expect(JSON.stringify(dto)).not.toContain('в очереди');
    expect(context.place()).toBe(0);
  });

  it('keeps a lock’s own sentence at the sixth, and never borrows our failure for it', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ proposedText: INTENT });
    // The law refuses the text: a harm lock the floor may not override with a FITS reading.
    db.prepare("UPDATE comments SET guard = 'legal' WHERE id = ?").run(id);

    for (let tryNo = 1; tryNo <= BACKOFFS.length + 1; tryNo += 1) {
      await context.pulse();
      if (tryNo <= BACKOFFS.length) h.clock.advance(BACKOFFS[tryNo - 1]! + 1);
    }

    // A lock was judged: the page reads the lock's own clause, the chain carries it, and the
    // retry door stays shut — this was not our failure.
    const sentence = HARM_LOCK_LINES.unpublishable;
    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'rejected', disposition: 'inadmissible', lock: 'harm', reason: sentence });
    const dto = toCommentDto(db, row, h.clock.ms);
    expect(dto).toMatchObject({ status: 'rejected', retryable: false, reason: sentence });
    expect(JSON.stringify(dto)).not.toContain('не дошло');
    expect(attemptOf(db, id)).toMatchObject({ outcome: 'refused', desperate: 1 });
  });

  it('keeps a recorded OFF’s own sentence at the sixth, and offers no retry for it', async () => {
    context = await bootTriage();
    const { db, h } = context;
    const id = await context.post({ proposedText: INTENT });
    // Gate C already read the filing as outside the book: the floor may not contradict it with a
    // FITS reading, and the stored sentence is the one the reader is owed.
    const sentence = 'вне книги: бумага не меняет ни одного факта';
    db.prepare("UPDATE comments SET audit_verdict = 'OFF', audit_reason = ? WHERE id = ?").run(sentence, id);

    for (let tryNo = 1; tryNo <= BACKOFFS.length + 1; tryNo += 1) {
      await context.pulse();
      if (tryNo <= BACKOFFS.length) h.clock.advance(BACKOFFS[tryNo - 1]! + 1);
    }

    const row = readCommentRow(db, id)!;
    expect(row).toMatchObject({ status: 'rejected', reason: sentence });
    const dto = toCommentDto(db, row, h.clock.ms);
    expect(dto).toMatchObject({ status: 'rejected', retryable: false, reason: sentence });
    expect(JSON.stringify(dto)).not.toContain('не дошло');
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

    // No clock ends it either: a paused day is a wait, and the row is where it was — the attempt
    // counter has not moved, so nothing has been spent and nothing may be decided.
    h.clock.advance(60 * 60_000);
    expect(await context.client.nextTriage('writer-triage-test')).toEqual({ assignment: null, reason: 'budget' });
    expect(readCommentRow(db, id)).toMatchObject({ status: 'new', disposition: null, reason: null });
    expect(attemptOf(db, id)).toMatchObject({ tries: 0, outcome: 'submitted', desperate: 0 });
    expect(context.calls).toHaveLength(0);
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
