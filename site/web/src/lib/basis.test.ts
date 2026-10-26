import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, type CatalogEntry } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { basisSentenceOf, chapterMatchesEntry } from './basis.ts';

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: (n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4) as CatalogEntry['part'],
    title: null,
    rev: 0,
    chars: 0,
    blocks: 1,
    written: false,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 34 ? 'forward' : 'backward',
    ...overrides,
  };
}

/** The catalog row of a slot that holds only its basis sentence. */
function basisSlot(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return entry(n, { basis: true, ...overrides });
}

describe('basisSentenceOf', () => {
  it('prints the frozen frame of a basis-only slot (BOOK-6)', () => {
    expect(basisSentenceOf(basisSlot(1))).toBe(FRAME_FIRST_SENTENCE);
    expect(basisSentenceOf(basisSlot(67))).toBe(FRAME_LAST_SENTENCE);
  });

  it('says nothing for an empty slot', () => {
    expect(basisSentenceOf(entry(2, { blocks: 0 }))).toBeNull();
  });

  it('says nothing for a written chapter, even a flagged one', () => {
    expect(basisSentenceOf(entry(1, { written: true, chars: 900, blocks: 12 }))).toBeNull();
    expect(basisSentenceOf(basisSlot(1, { written: true }))).toBeNull();
  });

  it('has no frame outside the two frame chapters', () => {
    expect(basisSentenceOf(basisSlot(8))).toBeNull();
  });
});

describe('chapterMatchesEntry', () => {
  it('matches a written chapter by revision', () => {
    expect(chapterMatchesEntry(entry(8, { rev: 3, written: true }), { rev: 3, basis: false })).toBe(true);
    expect(chapterMatchesEntry(entry(8, { rev: 4, written: true }), { rev: 3, basis: false })).toBe(false);
    expect(chapterMatchesEntry(entry(8, { rev: 3, written: true }), null)).toBe(false);
  });

  it('drops the prose of a chapter emptied to its basis sentence, which keeps its rev (BOOK-6)', () => {
    const slot = basisSlot(1, { rev: 5 });
    // The loaded text is still the old chapter: same rev, but the slot is now its frame.
    expect(chapterMatchesEntry(slot, { rev: 5, basis: false })).toBe(false);
    // Once the basis paragraph is loaded the slot and the chapter agree.
    expect(chapterMatchesEntry(slot, { rev: 5, basis: true })).toBe(true);
  });
});
