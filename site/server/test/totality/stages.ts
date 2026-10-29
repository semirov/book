/**
 * The six stages the matrix walks, one builder each: every one starts from the chain in `chain.ts`
 * and returns the cell a sink is read from. The builders are functions, not `it` blocks, because
 * the matrix and the invariant test drive the same rows.
 */

import type { WriterAssignment } from '@book/shared';
import { expect } from 'vitest';

import { TRIAGE_MAX_TRIES } from '../../src/comments/triage.ts';
import { admitPremise } from '../../src/engine/premise.ts';
import { newChangeId } from '../../src/util/ulid.ts';
import { readerSentences } from '../../src/writer/reasons.ts';
import {
  INTENT,
  answerOf,
  asSaid,
  type Call,
  type Context,
} from '../filingTriageHarness.ts';
import {
  CHAPTER,
  EMPTY_CHAPTER,
  GUARDED,
  chapterRev,
  landThatFails,
  longAnswer,
  patchAnswer,
  runThePass,
  scripted,
  type Cell,
  type Want,
} from './chain.ts';

// ── the stages' cells ─────────────────────────────────────────────────────────────────────────

/** The triage ladder: five model failures, then the engine's own sixth attempt. */
export async function triageLadder(ctx: Context, mode: 'floor' | 'refused'): Promise<Cell> {
  const commentId = await ctx.post({ proposedText: mode === 'floor' ? INTENT : GUARDED });
  const revBefore = chapterRev(ctx, CHAPTER);
  let n = 1;
  for (let tryNo = 1; tryNo <= TRIAGE_MAX_TRIES - 1; tryNo += 1) {
    const next = await ctx.client.nextTriage(`writer-${String(tryNo)}`);
    const assignment = next.assignment as { commentId: string; attempt: number } | null;
    expect(assignment, `claim ${String(tryNo)}`).toMatchObject({ commentId });
    n = assignment?.attempt ?? 1;
    const failed = (await ctx.client.failTriage({ commentId, n, code: 'PROVIDER_SHAPE' })) as {
      cap: boolean;
      nextAt: string | null;
    };
    if (tryNo < TRIAGE_MAX_TRIES - 1) {
      expect(failed.cap).toBe(false);
      ctx.h.clock.advance(Date.parse(String(failed.nextAt)) - ctx.h.clock.ms + 1);
    } else {
      // The fifth model failure is where the sixth attempt runs: the floor applies, or refuses.
      expect(failed.cap).toBe(mode === 'refused');
    }
  }
  expect(ctx.place()).toBe(mode === 'floor' ? 1 : 0);
  const change = ctx.db
    .prepare('SELECT id FROM changes WHERE source_comment = ?')
    .get(commentId) as { id: string } | undefined;
  return {
    ctx,
    chapter: CHAPTER,
    commentId,
    changeId: change?.id ?? null,
    revBefore,
    calls: ctx.calls.length,
  };
}

/** A claim that lapses: the process died under the call, five times, and the counter ends it. */
export async function lapsedClaims(ctx: Context, mode: 'floor' | 'refused'): Promise<Cell> {
  const commentId = await ctx.post({ proposedText: mode === 'floor' ? INTENT : GUARDED });
  const revBefore = chapterRev(ctx, CHAPTER);
  for (let tryNo = 1; tryNo <= TRIAGE_MAX_TRIES - 1; tryNo += 1) {
    expect((await ctx.client.nextTriage(`writer-${String(tryNo)}`)).assignment, `claim ${String(tryNo)}`).toMatchObject({
      commentId,
      tries: tryNo,
    });
    // The process is killed under the call: the try is counted, the lease is left in the past.
    ctx.db
      .prepare('UPDATE comment_attempts SET claim_until = ? WHERE comment_id = ? AND n = 1')
      .run(new Date(ctx.h.clock.ms - 1_000).toISOString(), commentId);
    ctx.h.clock.advance(1_000);
  }
  // The widening is a fact of the ledger, not of whichever process made the fourth claim.
  const attempt = ctx.db.prepare('SELECT widened, tries FROM comment_attempts WHERE comment_id = ? AND n = 1').get(commentId) as {
    widened: string | null;
    tries: number;
  };
  expect(attempt).toMatchObject({ widened: 'as-document', tries: TRIAGE_MAX_TRIES - 1 });
  // The sweep runs the sixth attempt: no clock decides, the count does.
  await ctx.pulse();
  expect(ctx.place()).toBe(mode === 'floor' ? 1 : 0);
  const change = ctx.db
    .prepare('SELECT id FROM changes WHERE source_comment = ?')
    .get(commentId) as { id: string } | undefined;
  return { ctx, chapter: CHAPTER, commentId, changeId: change?.id ?? null, revBefore, calls: ctx.calls.length };
}

/** A filing placed as a pending change on the written chapter: the pen's and gates' starting point. */
export async function placedFiling(ctx: Context): Promise<Cell> {
  const commentId = await ctx.post();
  ctx.script.push(answerOf({ itemId: commentId } as Call, 'FITS', asSaid()));
  await ctx.pulse();
  expect(ctx.place()).toBe(1);
  const change = ctx.db
    .prepare('SELECT id FROM changes WHERE source_comment = ?')
    .get(commentId) as { id: string } | undefined;
  expect(change?.id).toBeTruthy();
  return { ctx, chapter: CHAPTER, commentId, changeId: change?.id ?? null, revBefore: chapterRev(ctx, CHAPTER) };
}

/** An empty slot whose filing is its premise: the pen's sixth attempt has no paragraph to use. */
export async function premiseFiling(ctx: Context): Promise<Cell> {
  const posted = await ctx.h.app.inject({
    method: 'POST',
    url: '/api/comments',
    headers: ctx.h.headers(),
    payload: {
      chapter: EMPTY_CHAPTER,
      body: 'Девятая глава начинается с письма.',
      proposedText: INTENT,
      interventionKind: 'document',
    },
  });
  expect(posted.statusCode).toBe(201);
  const commentId = (posted.json() as { comment: { id: string } }).comment.id;
  const id = newChangeId(ctx.h.clock.now().getTime());
  admitPremise(ctx.db, {
    id,
    kind: 'operator',
    chapter: EMPTY_CHAPTER,
    intent: INTENT,
    interventionKind: 'document',
    sourceComment: commentId,
    sourceSession: null,
    at: new Date(ctx.h.clock.ms).toISOString(),
  });
  return { ctx, chapter: EMPTY_CHAPTER, commentId, changeId: id, revBefore: chapterRev(ctx, EMPTY_CHAPTER) };
}

/** The queue's own bound: a lane held by another change, and every poll one counted claim. */
export async function queueClaims(ctx: Context, mode: 'sixth-claim-wins' | 'sixth-claim-drops'): Promise<Cell> {
  const holder = ctx.engine.enqueue({ kind: 'operator', chapter: CHAPTER, intent: 'среда вместо четверга' });
  const holderJob = ctx.engine.next({ for: 'filing', session: 'writer-holder' }) as WriterAssignment | null;
  expect(holderJob?.changeId).toBe(holder.id);

  const cell = await placedFiling(ctx);
  // Five claims that produce no step: the lane is held, and each poll is the count.
  for (let claim = 1; claim < 6; claim += 1) {
    expect(ctx.engine.next({ for: 'filing', session: `writer-${String(claim)}` })).toBeNull();
    expect(ctx.db.prepare('SELECT attempts FROM changes WHERE id = ?').get(cell.changeId)).toEqual({ attempts: claim });
  }

  if (mode === 'sixth-claim-drops') {
    expect(ctx.engine.next({ for: 'filing', session: 'writer-sixth' })).toBeNull();
    // A seventh poll is impossible: the change left the queue and no counter moves.
    expect(ctx.engine.next({ for: 'filing', session: 'writer-seventh' })).toBeNull();
    expect(ctx.db.prepare('SELECT attempts FROM changes WHERE id = ?').get(cell.changeId)).toEqual({ attempts: 6 });
    return { ...cell, result: undefined };
  }

  // The blocker leaves the lane before the sixth claim: the last attempt finds the lane free.
  ctx.engine.escalate(holderJob?.leaseId ?? '', 'среда вместо четверга не подошла');
  const claimed = ctx.engine.next({ for: 'filing', session: 'writer-sixth' }) as WriterAssignment | null;
  expect(claimed?.changeId).toBe(cell.changeId);
  await driveToDone(ctx, claimed as WriterAssignment);
  return cell;
}

/** The scripted session's own close, written the way `driveStub` writes it. */
async function driveToDone(ctx: Context, job: WriterAssignment): Promise<void> {
  await ctx.client.start(job.leaseId);
  await ctx.client.land(job.leaseId, { text: longAnswer() });
  for (const role of ['editor', 'consultant'] as const) {
    const gate = await ctx.client.nextGate(role, `gate-${role}`);
    expect(gate, `${role} dispatch`).not.toBeNull();
    await ctx.client.verdict({
      stepId: gate!.stepId,
      role,
      session: gate!.session,
      verdict: 'HOLDS',
      findings: [],
      model: ctx.config.model,
      tokensIn: 120,
      tokensOut: 12,
    });
  }
  const rights = await ctx.client.nextRightsGate('gate-rights');
  expect(rights).not.toBeNull();
  await ctx.client.verdictRights({
    stepId: rights!.stepId,
    role: 'rights',
    session: rights!.session,
    verdict: 'CLEAR',
    rule: null,
    model: ctx.config.model,
    tokensIn: 0,
    tokensOut: 0,
  });
  await ctx.client.done({
    leaseId: job.leaseId,
    seams: [],
    note: 'totality: the sixth claim found the lane',
    model: ctx.config.model,
    tokensIn: 500,
    tokensOut: 80,
  });
}

/** The sentences the ladder and the queue may print, for the copy-hygiene test. */

// ── the landing, and a lock ──────────────────────────────────────────────────────────────────
//
// The pen's and the gates' ladders are the engine's now (BOOK-DOC-84 §10.8: five leases, the
// widening at the third failure, the desperate sixth), and their sink is asserted where those
// frames live (`server/test/engine/rules.test.ts`): the change ends `void · dropped` with its own
// sentence. The cells here are the stages this branch's own rule covers — the reading's ladder
// and the queue's claims — plus the two doors the pass owns: its landing and a lock.

export async function landRetried(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  const cell = await placedFiling(ctx);
  const transfer = landThatFails(ctx, 1);
  const plan = scripted(ctx.config.model, [patchAnswer(ctx), 'HOLDS', 'HOLDS', 'CLEAR']);
  cell.result = await runThePass(ctx, plan.provider, transfer.client);
  cell.calls = plan.calls();
  // The first request fails and the client asks again; the second one publishes the candidate,
  // and the close is what serves it (BOOK-222).
  expect(transfer.attempts(), 'the land request was asked twice').toBeGreaterThanOrEqual(2);
  return { cell, want: { sink: 'written', status: 'closed' } };
}

/** (b) The landing: both attempts fail, nothing is published, and the reader is told whose it was. */
export async function landRefused(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  const cell = await placedFiling(ctx);
  const transfer = landThatFails(ctx, 2);
  const plan = scripted(ctx.config.model, [patchAnswer(ctx)]);
  cell.result = await runThePass(ctx, plan.provider, transfer.client);
  cell.calls = plan.calls();
  expect(cell.calls, 'the draft only: the landing never reached the gates').toBe(1);
  expect(transfer.attempts(), 'the land request spent both transport attempts').toBe(2);
  return {
    cell,
    want: { sink: 'refused', status: 'parked', reader: readerSentences.engineDown, kind: 'technical' },
  };
}

/** A lock the reading names: a decision about the text, and the sentence is the lock's own. */
export async function lockRefused(ctx: Context): Promise<{ cell: Cell; want: Want }> {
  const commentId = await ctx.post();
  // A lock the reading names: only `finale` may be proposed, and an OFF verdict cannot be
  // read as said — the pair is `OFF` + `inadmissible`, exactly what the parser accepts.
  ctx.script.push(
    answerOf({ itemId: commentId } as Call, 'OFF', {
      rung: 'inadmissible',
      lock: 'finale',
      intent: INTENT,
      carrier: null,
      refusal: null,
    }),
  );
  await ctx.pulse();
  expect(ctx.place()).toBe(1);
  const cell: Cell = { ctx, chapter: CHAPTER, commentId, changeId: null, revBefore: chapterRev(ctx, CHAPTER) };
  return { cell, want: { sink: 'refused', reader: /отменяет исход/u, kind: 'lock' } };
}
