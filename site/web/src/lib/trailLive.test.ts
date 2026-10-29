import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { filingsMissingFrom, withFilingUpdate } from './trailLive.ts';

/**
 * BOOK-DOC-84 #17/D6 — the trail row moves by frame, not by reload.
 */

const comment = (overrides: Partial<CommentDto> = {}): CommentDto =>
  ({
    id: 'cmt_1',
    chapter: 4,
    anchor: { blockId: 'ch04#a', blockIndex: 0, quote: 'цитата', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: 'red',
    body: 'тело',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    frame: null,
    premise: false,
    reason: null,
    attempt: null,
    revise: { allowed: false, at: null, attemptsLeft: 3, closed: false, blocked: null },
    createdAt: '2026-10-29T10:00:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  }) as CommentDto;

const update = (overrides: Partial<Parameters<typeof withFilingUpdate>[1]> = {}) => ({
  commentId: 'cmt_1',
  chapter: 4,
  state: 'accepted' as const,
  attempts: 1,
  attemptsLeft: 2,
  changeId: 'chg_2' as string | null,
  at: 1_764_000_000_000,
  ...overrides,
});

describe('a filing’s row, patched by its frame', () => {
  it('carries the state, the tries left and the change', () => {
    const next = withFilingUpdate(comment(), update());
    expect(next?.status).toBe('accepted');
    expect(next?.revise?.attemptsLeft).toBe(2);
    expect(next?.changeId).toBe('chg_2');
  });

  it('reads the wire’s refusal and hold in the reader’s own words', () => {
    expect(withFilingUpdate(comment(), update({ state: 'refused' }))?.status).toBe('rejected');
    expect(withFilingUpdate(comment(), update({ state: 'held' }))?.status).toBe('quarantined');
    expect(withFilingUpdate(comment(), update({ state: 'expired' }))?.status).toBe('expired');
    expect(withFilingUpdate(comment(), update({ state: 'registered' }))?.status).toBe('registered');
  });

  it('changes nothing for a duplicate frame', () => {
    const row = comment({ status: 'accepted', changeId: 'chg_2', revise: { allowed: false, at: null, attemptsLeft: 2, closed: false, blocked: null } });
    expect(withFilingUpdate(row, update())).toBeNull();
  });

  it('keeps a row that carries no `revise` without inventing one', () => {
    const row = comment({ revise: undefined });
    const next = withFilingUpdate(row, update());
    expect(next?.revise).toBeUndefined();
  });
});

describe('a filing the page has not read yet', () => {
  it('names the ids the fetched page is missing, once', () => {
    const rows = [comment({ id: 'cmt_1' })];
    const live = [
      { commentId: 'cmt_1', chapter: 4, state: 'new', attempts: 0, attemptsLeft: 3, changeId: null, at: '2026-10-29T10:00:00Z' },
      { commentId: 'cmt_2', chapter: 5, state: 'new', attempts: 0, attemptsLeft: 3, changeId: null, at: '2026-10-29T10:00:00Z' },
    ];
    expect(filingsMissingFrom(rows, live)).toEqual(['cmt_2']);
    expect(filingsMissingFrom(rows, undefined)).toEqual([]);
  });
});
