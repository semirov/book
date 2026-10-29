// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentRecord, openRecord, resetRecordMemory } from './record.ts';
import { currentFiling, hideFiling, showFiling } from './useFiling.ts';

/**
 * The **one card** and the record are different places now.
 *
 * The card is the named exception (a premise, a filing with no sentence); the record is every
 * sentence's surface. Showing the card must **not** close the record (the BOOK-128 coupling is
 * gone), while opening a record still takes the card's slot — one reading surface at a time.
 */

let filed = 0;

function comment(id: string): CommentDto {
  filed += 1;
  return {
    attempt: null,
    id,
    number: filed,
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    premise: false,
    reason: null,
    refusal: null,
    frame: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
  };
}

afterEach(() => {
  hideFiling();
  resetRecordMemory();
  vi.restoreAllMocks();
});

describe('the one card left on the page', () => {
  it('shows one card at a time: the second replaces the first', () => {
    expect(currentFiling()).toBeNull();
    showFiling({ owner: 'ch08#aa11bb22', comment: comment('cmt_a'), origin: null });
    expect(currentFiling()?.comment.id).toBe('cmt_a');
    expect(currentFiling()?.owner).toBe('ch08#aa11bb22');

    showFiling({ owner: 'ch08#cc33dd44', comment: comment('cmt_b'), origin: null });
    expect(currentFiling()?.comment.id).toBe('cmt_b');
    expect(currentFiling()?.owner).toBe('ch08#cc33dd44');
  });

  it('hides to an empty page, and hiding twice is not an error', () => {
    showFiling({ owner: 'one', comment: comment('cmt_b'), origin: null });
    hideFiling();
    expect(currentFiling()).toBeNull();
    hideFiling();
    expect(currentFiling()).toBeNull();
  });

  it('does not close the record (one register, two different places)', () => {
    openRecord({
      chapter: 8,
      blockId: 'ch08#aa11bb22',
      start: 0,
      end: 22,
      anchor: null,
      origin: null,
      filing: comment('cmt_record'),
    });
    showFiling({ owner: 'chapter-8', comment: comment('cmt_premise'), origin: null });
    expect(currentRecord()?.filing?.id).toBe('cmt_record');
    expect(currentFiling()?.comment.id).toBe('cmt_premise');
  });

  it('a record takes the card’s slot: opening one closes the card, never the other way', () => {
    showFiling({ owner: 'chapter-8', comment: comment('cmt_premise'), origin: null });
    openRecord({
      chapter: 8,
      blockId: 'ch08#aa11bb22',
      start: 0,
      end: 22,
      anchor: null,
      origin: null,
      filing: comment('cmt_record'),
    });
    expect(currentFiling()).toBeNull();
    expect(currentRecord()?.filing?.id).toBe('cmt_record');
  });
});
