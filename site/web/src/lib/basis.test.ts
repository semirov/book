import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, partOf, TOTAL_CHAPTERS, type CatalogEntry } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { basisSentenceOf, chapterMatchesEntry } from './basis.ts';

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: partOf(n),
    title: null,
    rev: 0,
    chars: 0,
    blocks: 1,
    written: false,
    basis: false,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 21 ? 'forward' : 'backward',
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
    expect(basisSentenceOf(basisSlot(TOTAL_CHAPTERS))).toBe(FRAME_LAST_SENTENCE);
  });

  it('prefers the served block over the compiled constant (BOOK-187 AC3)', () => {
    // The volume is the source: a row edited by hand is what the reader must see, and the
    // constant is only the fallback the offline shell prints before the answer arrives.
    const edited = `${FRAME_FIRST_SENTENCE} (правка владельца)`;
    expect(basisSentenceOf(basisSlot(1), { basis: true, blocks: [{ id: 'ch01#abc', i: 0, text: edited, hash: 'abc' }] })).toBe(edited);
    // No usable payload — no blocks, or a chapter that is not a basis projection: the constant.
    expect(basisSentenceOf(basisSlot(1), { basis: true, blocks: [] })).toBe(FRAME_FIRST_SENTENCE);
    expect(basisSentenceOf(basisSlot(1), { basis: false, blocks: [{ id: 'ch01#abc', i: 0, text: 'текст', hash: 'abc' }] })).toBe(
      FRAME_FIRST_SENTENCE,
    );
    expect(basisSentenceOf(basisSlot(1), null)).toBe(FRAME_FIRST_SENTENCE);
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
