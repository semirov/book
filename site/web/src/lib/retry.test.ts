import type { CommentDto, FilingUpdatePayload, LiveReading } from '@book/shared';
import { describe, expect, it } from 'vitest';

import type { ChangeLine } from './clientState.ts';
import { RETRY_WORD, retryOffer } from './retry.ts';
import { REVISE_EXHAUSTED } from './revise.ts';

/**
 * BOOK-220 §11.3 — «повторить» exists for our failure alone.
 *
 * The matrix, one row per class the brief names: attempts spent, a provider/shape failure and a
 * rolled-back pass offer the word; a lock (право, вред, рамка, финал), a content refusal, the
 * budget and a landing do not. The cap's spent state hides the word and keeps one honest line.
 */

function filing(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 8,
    anchor: { blockId: 'ch08#b1', blockIndex: 0, quote: 'Фраза.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'пояснение',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    attempt: null,
    frame: null,
    premise: false,
    reason: null,
    createdAt: '2026-10-28T21:24:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

const noFrames = { change: null, reading: null, update: null, decision: null };

describe('the retry matrix', () => {
  it('offers the word for a provider or shape failure', () => {
    const offer = retryOffer({ ...noFrames, comment: filing({ attempt: 'failed' }) });
    expect(offer).toEqual({ kind: 'word' });
    expect(RETRY_WORD).toBe('повторить');
  });

  it('offers the word for a pass the engine rolled back', () => {
    const change: ChangeLine = {
      kind: 'decided',
      at: 1,
      eventSeq: 1,
      payload: {
        id: 'chg_1',
        commentId: 'cmt_1',
        outcome: 'failed',
        reason: null,
        chapters: [8],
        cascade: {
          id: 'csc_1',
          outcome: 'escalated:gate_timeout',
          waves: 1,
          touched: [8],
          rewritten: [8],
          wings: {
            down: { frontier: 8, wave: 1, state: 'stopped', reached: [8] },
            up: { frontier: 8, wave: 1, state: 'stopped', reached: [8] },
          },
          seams: [],
          finding: false,
        },
        relevance: null,
        tokens: { total: 0 },
        decidedAt: '2026-10-28T21:31:00Z',
        at: 1,
        eventSeq: 1,
      },
    };
    expect(retryOffer({ ...noFrames, change, comment: filing({ status: 'rejected', reason: 'проверка не ответила' }) })).toEqual({
      kind: 'word',
    });
  });

  it('never offers the word for a lock, a refusal, the budget or a landing', () => {
    const budget: ChangeLine = {
      kind: 'decided',
      at: 1,
      eventSeq: 1,
      payload: {
        id: 'chg_2',
        commentId: 'cmt_1',
        outcome: 'escalated',
        reason: null,
        chapters: [8],
        cascade: {
          id: 'csc_2',
          outcome: 'escalated:budget',
          waves: 3,
          touched: [8],
          rewritten: [8],
          wings: {
            down: { frontier: 8, wave: 3, state: 'stopped', reached: [8] },
            up: { frontier: 8, wave: 3, state: 'stopped', reached: [8] },
          },
          seams: [],
          finding: false,
        },
        relevance: null,
        tokens: { total: 0 },
        decidedAt: '2026-10-28T21:31:00Z',
        at: 1,
        eventSeq: 1,
      },
    };
    const locks = [
      filing({ status: 'rejected', refusal: 'rights', reason: 'не принято: пересказ' }),
      filing({ status: 'rejected', refusal: 'auditor', reason: 'вне книги' }),
      filing({ status: 'quarantined' }),
      filing({ status: 'applied', applied: { chapter: 8, rev: 4 } }),
      filing({ status: 'hidden' }),
      filing({ status: 'rejected', reason: 'правка ушла глубже 2 волн — дальше только по решению владельца' }),
    ];
    for (const comment of locks) {
      expect(retryOffer({ ...noFrames, comment }), comment.status).toEqual({ kind: 'none' });
    }
    // A budget stop is decided against the reader's filing, not a failure of the machinery.
    expect(retryOffer({ ...noFrames, change: budget, comment: filing({ status: 'rejected' }) })).toEqual({
      kind: 'none',
    });
  });

  it('hides the word when the retry cap is spent, and says what is left', () => {
    const reading: LiveReading = {
      commentId: 'cmt_1',
      chapter: 8,
      phase: 'failed',
      attempt: 5,
      maxAttempts: 5,
      widened: null,
      desperate: false,
      since: 1,
      deadlineAt: null,
      retryAt: null,
      reason: 'таймаут',
    };
    expect(retryOffer({ ...noFrames, comment: filing({ attempt: 'failed' }), reading })).toEqual({
      kind: 'spent',
      line: REVISE_EXHAUSTED,
    });
    const update: FilingUpdatePayload = {
      commentId: 'cmt_1',
      chapter: 8,
      state: 'new',
      attempts: 3,
      attemptsLeft: 0,
      changeId: null,
      at: 2,
    };
    expect(retryOffer({ ...noFrames, comment: filing({ attempt: 'failed' }), update })).toEqual({
      kind: 'spent',
      line: REVISE_EXHAUSTED,
    });
    expect(retryOffer({ ...noFrames, comment: filing({ revise: { allowed: false, at: null, attemptsLeft: 0, closed: true, blocked: 'attempts' } }) })).toEqual({
      kind: 'spent',
      line: REVISE_EXHAUSTED,
    });
  });

  it('names no class when the page holds neither a frame nor a failure', () => {
    expect(retryOffer({ ...noFrames, comment: null })).toEqual({ kind: 'none' });
    expect(retryOffer({ ...noFrames, comment: filing() })).toEqual({ kind: 'none' });
  });
});
