import { AUTHOR_COLORS, type CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  PLACE_NOTE,
  beginLanding,
  isCurrent,
  landingScroll,
  placeBlockId,
  placeBlockIndex,
  placeChangeId,
  placeHref,
  placeNote,
  type Place,
} from './place.ts';

/**
 * BOOK-168 — the door's pure half: the fragment a row prints and the arithmetic a landing
 * performs. jsdom has no layout, so the scroll math is stated here as numbers and proved in
 * `PlaceLink.dom.test.tsx` against stubbed boxes; nothing here needs a document.
 */

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 3,
    anchor: { blockId: 'ch03#b12', blockIndex: 12, quote: 'Я посмотрел на часы: девять сорок две.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'тут время не сходится',
    proposedText: null,
    interventionKind: null,
    frame: 'untouched',
    premise: false,
    status: 'new',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

const CHAPTER: Place = { chapter: 3 };

describe('the fragment a place prints', () => {
  it('points a resolved block filing at its own paragraph', () => {
    expect(placeHref(comment())).toBe('#ch-3-b12');
    expect(placeBlockIndex(comment())).toBe(12);
    expect(placeBlockId(comment())).toBe('ch03#b12');
  });

  it('points a premise at the chapter’s mouth, never at a block', () => {
    // A premise is the chapter's own row (BOOK-7): its anchor may quote nothing at all.
    const premise = comment({
      premise: true,
      anchor: { blockId: null, blockIndex: null, quote: '— Заявителем лично.', prefix: null, suffix: null, resolved: true },
    });
    expect(placeHref(premise)).toBe('#ch-3');
    expect(placeBlockIndex(premise)).toBeNull();
  });

  it('falls back to the chapter when the quote no longer resolves', () => {
    const stale = comment({
      anchor: { blockId: 'ch03#b12', blockIndex: 12, quote: 'Я посмотрел на часы.', prefix: null, suffix: null, resolved: false },
    });
    expect(placeHref(stale)).toBe('#ch-3');
    expect(placeBlockId(stale)).toBeNull();
  });

  it('names only the chapter before the filing is read, and for a change with no filing', () => {
    expect(placeHref({ commentId: 'cmt_9', chapter: 7 })).toBe('#ch-7');
    expect(placeHref({ chapter: 7, changeId: 'chg_9' })).toBe('#ch-7');
    expect(placeHref(CHAPTER)).toBe('#ch-3');
  });
});

describe('the card’s one honesty line', () => {
  it('is printed only for a filing the log says is no longer there', () => {
    const stale = comment({
      anchor: { blockId: 'ch03#b12', blockIndex: 12, quote: 'Я посмотрел на часы.', prefix: null, suffix: null, resolved: false },
    });
    expect(placeNote(stale, true)).toBe(PLACE_NOTE);
    expect(placeNote(stale, false)).toBeNull();
  });

  it('is silent for a live anchor whose paragraph the page has not read', () => {
    // A resolved anchor and an absent block are two different facts: the chapter may simply not
    // have been fetched yet, and «место изменилось после правки» would be a claim nobody made.
    expect(placeNote(comment(), true)).toBeNull();
  });

  it('never contradicts a premise: the chapter is its own place', () => {
    const premise = comment({ premise: true, anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true } });
    expect(placeNote(premise, true)).toBeNull();
  });

  it('is silent for a change with no filing on the page', () => {
    expect(placeNote(CHAPTER, true)).toBeNull();
    expect(placeNote({ commentId: 'cmt_9', chapter: 7 }, true)).toBeNull();
  });
});

describe('the card a place hands over to', () => {
  it('is the filing’s own change, the row’s, or none at all', () => {
    expect(placeChangeId(comment({ changeId: 'chg_1' }))).toBe('chg_1');
    expect(placeChangeId(comment({ changeId: null }))).toBeNull();
    expect(placeChangeId({ commentId: 'cmt_9', chapter: 7, changeId: 'chg_9' })).toBe('chg_9');
    expect(placeChangeId({ commentId: 'cmt_9', chapter: 7 })).toBeNull();
    expect(placeChangeId(CHAPTER)).toBeNull();
  });
});

describe('one landing at a time', () => {
  it('hands the page to the newest landing and drops every older one', () => {
    // A click, a hash and a back/forward are landings on one page: the second tap is a landing
    // of its own, and the first may no longer scroll or open a card.
    const first = beginLanding();
    expect(isCurrent(first)).toBe(true);
    const second = beginLanding();
    expect(second).not.toBe(first);
    expect(isCurrent(first)).toBe(false);
    expect(isCurrent(second)).toBe(true);
    // A token from another page (a number nobody issued) is never current.
    expect(isCurrent(second + 1)).toBe(false);
  });
});

describe('the landing’s arithmetic', () => {
  it('puts the target’s top at the reading line', () => {
    // A head of 56 px + 8 breathing: the chapter begins at 2 000 document pixels.
    expect(landingScroll({ docTop: 2000, readingLine: 64, gripFloor: 700, maxScroll: 5000 })).toBe(1936);
  });

  it('is a no-op at the top of the page, never a negative scroll', () => {
    expect(landingScroll({ docTop: 10, readingLine: 64, gripFloor: 700, maxScroll: 5000 })).toBe(0);
  });

  it('clamps at the end of the book, where the page cannot travel further', () => {
    // 3 000 px of document under a 844 px viewport: the last scroll is 2 156, not 3 936.
    expect(landingScroll({ docTop: 4000, readingLine: 64, gripFloor: 764, maxScroll: 2156 })).toBe(2156);
  });

  it('pulls the target up to the grip’s floor on a viewport too short for both bands', () => {
    // A 60 px viewport (a keyboard open): the reading line is deeper than the grip's floor, so
    // the target is lifted to the floor instead of landing under the band.
    expect(landingScroll({ docTop: 2000, readingLine: 200, gripFloor: 150, maxScroll: 5000 })).toBe(1850);
  });

  it('has no ceiling to read in a document without layout', () => {
    expect(landingScroll({ docTop: 2000, readingLine: 64, gripFloor: 700, maxScroll: null })).toBe(1936);
  });
});
