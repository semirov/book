// @vitest-environment jsdom
import type { CommentDto } from '@book/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { currentSeam, openSeam } from './useSeam.ts';
import { currentFiling, showFiling } from './useFiling.ts';
import { currentRevision, showRevision } from './useRevision.ts';
import { closeOverlays } from './overlays.ts';

/**
 * BOOK-111 (owner, 2026-10-27) — `closeOverlays` is the one act that clears the page.
 *
 * Two half-written surfaces must never coexist, and the прицел is a mode of the same page:
 * entering it drops the seam, the panel and the record in one call.
 */

function comment(): CommentDto {
  return {
    id: 'cmt_0123',
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
const anchor = {
  sentence: { start: 0, end: 26, text: 'Я вошёл в пустую комнату.' },
  quote: 'Я вошёл в пустую комнату.',
  prefix: '',
  suffix: '',
  word: 'вошёл',
  blockId: 'ch08#aa11bb22',
  baseRev: 3,
};

afterEach(() => {
  closeOverlays();
});

describe('entering the прицел closes every overlay', () => {
  it('drops the seam, the panel and the revision object together', () => {
    openSeam({ chapter: 8, blockId: 'ch08#aa11bb22', key: 'ch8:text', anchor, origin: null });
    showFiling({ kind: 'filing', owner: 'ch08#aa11bb22', comment: comment(), origin: null, rect });
    showRevision({ comment: comment(), origin: null });
    expect(currentSeam()).not.toBeNull();
    expect(currentFiling()).not.toBeNull();
    expect(currentRevision()).not.toBeNull();

    closeOverlays();

    expect(currentSeam()).toBeNull();
    expect(currentFiling()).toBeNull();
    expect(currentRevision()).toBeNull();
  });
});
