// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentFiling, hideFiling, showFiling } from './useFiling.ts';
import { currentRevision, hideRevision, showRevision } from './useRevision.ts';

/**
 * BOOK-111 (owner, 2026-10-27) — the page's one panel slot.
 *
 * A filing card and a word's provenance panel are the same slot: showing one replaces the
 * other, never stacks it. The store carries the surface that opened it (`owner`), so only
 * that surface draws the panel, and closing is idempotent. The second slot — the revision
 * object — is closed by these stores too, in both directions, never by a call site.
 */

function comment(id: string): CommentDto {
  return {
    id,
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
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
  };
}

const rect = { width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

afterEach(() => {
  hideFiling();
  hideRevision();
  vi.restoreAllMocks();
});

describe('the page’s one filing panel', () => {
  it('shows one panel at a time: the second replaces the first', () => {
    expect(currentFiling()).toBeNull();
    showFiling({ kind: 'filing', owner: 'ch08#aa11bb22', comment: comment('cmt_a'), origin: null, rect, fromSeam: false });
    expect(currentFiling()?.comment?.id).toBe('cmt_a');
    expect(currentFiling()?.owner).toBe('ch08#aa11bb22');

    showFiling({
      kind: 'provenance', owner: 'ch08#cc33dd44', comment: null, origin: null, rect, word: 'слово', fromSeam: false,
    });
    expect(currentFiling()?.kind).toBe('provenance');
    expect(currentFiling()?.word).toBe('слово');
    expect(currentFiling()?.comment).toBeNull();
  });

  it('hides to an empty page, and hiding twice is not an error', () => {
    showFiling({ kind: 'filing', owner: 'one', comment: comment('cmt_b'), origin: null, rect, fromSeam: false });
    hideFiling();
    expect(currentFiling()).toBeNull();
    hideFiling();
    expect(currentFiling()).toBeNull();
  });

  it('a card opens over no record: showing a filing hides the open revision object', () => {
    showRevision({ comment: comment('cmt_r1'), origin: null });
    expect(currentRevision()).not.toBeNull();

    showFiling({ kind: 'filing', owner: 'ch08#aa11bb22', comment: comment('cmt_f'), origin: null, rect, fromSeam: false });

    expect(currentRevision()).toBeNull();
    expect(currentFiling()?.comment?.id).toBe('cmt_f');
  });

  it('a record opens over no card: showing a revision hides the open filing', () => {
    showFiling({ kind: 'filing', owner: 'ch08#aa11bb22', comment: comment('cmt_f'), origin: null, rect, fromSeam: false });
    expect(currentFiling()).not.toBeNull();

    showRevision({ comment: comment('cmt_r2'), origin: null });

    expect(currentFiling()).toBeNull();
    expect(currentRevision()?.comment.id).toBe('cmt_r2');
  });
});
