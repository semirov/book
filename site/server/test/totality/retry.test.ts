/**
 * The retry closes the loop (owner, 2026-10-29): «повторить» is not a new filing, and it is the
 * one door out of a sink that was **our** failure.
 *
 * The chain a reader lives through: a read that never answered ends `rejected` with the honest
 * sentence and `retryable: true`; the retry re-arms the same row on a fresh attempt; the read
 * then answers; the filing is placed; and the pass — row (a) of the matrix — ends `written`.
 * Nothing is erased and nothing is counted twice: two attempt rows, one change, one landing.
 */

import { describe, expect, it } from 'vitest';

import { TRIAGE_REFUSED_LINE, type CommentDto } from '@book/shared';

import { dueTriage } from '../../src/comments/triage.ts';

import { EngineBridge } from '../../src/engineState/bridge.ts';
import { bootChain, chapterRev, chainedAnswers, expectSink, factsOf, runThePass, type Frame } from './chain.ts';
import { triageLadder } from './stages.ts';
import { answerOf, asSaid, type Call } from '../filingTriageHarness.ts';

describe('a retry of our failure ends in the written sink', () => {
  it('re-arms the filing, reads it again, and the pass writes the chapter', async () => {
    const ctx = await bootChain();
    try {
      // (1) Five reads fail and the engine's sixth cannot apply the floor: our failure, one word.
      const cell = await triageLadder(ctx, 'refused');
      expectSink(cell, { sink: 'refused', reader: TRIAGE_REFUSED_LINE });
      expect(chapterRev(ctx, cell.chapter)).toBe(cell.revBefore);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual({ n: 0 });

      // (2) The page offers the button only because the failure was ours.
      const refused = (await ctx.h.app.inject({ method: 'GET', url: `/api/comments/${cell.commentId}` })).json() as CommentDto;
      expect(refused).toMatchObject({ status: 'rejected', retryable: true, reason: TRIAGE_REFUSED_LINE, decidedAt: expect.any(String) });

      // (3) The retry re-arms the same row: the words stay, the failure stays in the trail, and
      //     the ladder starts again on the next attempt.
      const retried = await ctx.h.app.inject({
        method: 'POST',
        url: `/api/comments/${cell.commentId}/retry`,
        headers: ctx.h.headers(),
        payload: {},
      });
      expect(retried.statusCode).toBe(200);
      expect((retried.json() as { comment: CommentDto }).comment).toMatchObject({
        id: cell.commentId,
        status: 'new',
        reason: null,
        retryable: false,
        decidedAt: null,
      });
      const attempts = ctx.db
        .prepare('SELECT n, outcome FROM comment_attempts WHERE comment_id = ? ORDER BY n')
        .all(cell.commentId) as Array<{ n: number; outcome: string }>;
      expect(attempts).toEqual([
        { n: 1, outcome: 'refused' },
        { n: 2, outcome: 'submitted' },
      ]);

      // (4) The read is due again on the new attempt, and this time it answers. The due check is
      //     a query, not a claim: a claim here would buy the attempt the pulse then cannot take.
      expect(dueTriage(ctx.db, new Date(ctx.h.clock.ms).toISOString())).toEqual([
        expect.objectContaining({ commentId: cell.commentId, n: 2, tries: 0 }),
      ]);
      ctx.script.push(answerOf({ itemId: cell.commentId } as Call, 'FITS', asSaid()));
      await ctx.pulse();
      expect(ctx.place()).toBe(1);

      // (5) The pass writes it: row (a) of the matrix, on the re-armed filing. The bridge is
      //     primed here, so the frames read below are the close's own — not yesterday's retry.
      const heard: Frame[] = [];
      const bridge = new EngineBridge({
        db: ctx.db,
        emit: (type, data) => heard.push({ type: String(type), data: data as Record<string, unknown> }),
        progressThrottleMs: 0,
        now: () => ctx.h.clock.ms,
      });
      bridge.prime();
      // A phrase filing's prompt asks for a patch, not a chapter (BOOK-173): the answer is the
      // one JSON object the writer's own parser accepts.
      const plan = chainedAnswers(ctx);
      const result = await runThePass(ctx, plan.provider);
      bridge.tick();
      expect(result.status).toBe('closed');

      const change = ctx.db
        .prepare('SELECT id, status, outcome, source_comment FROM changes WHERE source_comment = ?')
        .all(cell.commentId) as Array<{ id: string; status: string; outcome: string; source_comment: string }>;
      expect(change).toHaveLength(1);
      const written = { ...cell, changeId: change[0]!.id, result };
      // The four facts, read together: the chapter moved by one revision, the change is
      // `done · applied`, the filing reads `applied`, and the close spoke once to the page. The
      // retry itself left a frame too (BOOK-206 B5) — a re-armed row is not a second decision.
      const facts = factsOf(written);
      expect(facts.change).toMatchObject({ status: 'done', outcome: 'applied' });
      expect(facts.rev).toBe(cell.revBefore + 1);
      expect(facts.dto.status).toBe('applied');
      expect(facts.dto.applied).toEqual({ chapter: cell.chapter, rev: facts.rev });
      expect(facts.dto.retryable).toBe(false);
      expect(facts.changeFrames).toHaveLength(1);
      expect(facts.changeFrames[0]?.data).toMatchObject({ id: change[0]!.id, outcome: 'applied' });
      expect(heard.filter((frame) => frame.type === 'change:decided')).toHaveLength(1);
      expect(heard.filter((frame) => frame.type === 'comment:decision' && frame.data.id === cell.commentId)).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ id: cell.commentId, status: 'applied' }) }),
      ]);
      expect(facts.stages.at(-1)?.stage).toBe('landed');
      // Two attempts, one accepted: the retry did not submit the filing a second time.
      expect(
        ctx.db.prepare('SELECT COUNT(*) AS n FROM comment_attempts WHERE comment_id = ?').get(cell.commentId),
      ).toEqual({ n: 2 });
    } finally {
      await ctx.close();
    }
  });
});
