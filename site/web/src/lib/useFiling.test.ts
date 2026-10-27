// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { currentFiling, hideFiling, showFiling } from './useFiling.ts';

/**
 * BOOK-111 (owner, 2026-10-27) — the page's one panel slot.
 *
 * A filing card and a word's provenance panel are the same slot: showing one replaces the
 * other, never stacks it. The store carries the surface that opened it (`owner`), so only
 * that surface draws the panel, and closing is idempotent.
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
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
  };
}

const rect = { width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

afterEach(() => {
  hideFiling();
  vi.restoreAllMocks();
});

describe('the page’s one filing panel', () => {
  it('shows one panel at a time: the second replaces the first', () => {
    expect(currentFiling()).toBeNull();
    showFiling({ kind: 'filing', owner: 'ch08#aa11bb22', comment: comment('cmt_a'), origin: null, rect });
    expect(currentFiling()?.comment?.id).toBe('cmt_a');
    expect(currentFiling()?.owner).toBe('ch08#aa11bb22');

    showFiling({ kind: 'provenance', owner: 'ch08#cc33dd44', comment: null, origin: null, rect, word: 'слово' });
    expect(currentFiling()?.kind).toBe('provenance');
    expect(currentFiling()?.word).toBe('слово');
    expect(currentFiling()?.comment).toBeNull();
  });

  it('hides to an empty page, and hiding twice is not an error', () => {
    showFiling({ kind: 'filing', owner: 'one', comment: comment('cmt_b'), origin: null, rect });
    hideFiling();
    expect(currentFiling()).toBeNull();
    hideFiling();
    expect(currentFiling()).toBeNull();
  });
});
