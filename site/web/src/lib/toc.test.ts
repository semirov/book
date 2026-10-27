import { chapterStartPages, FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, type CatalogEntry, type StateSnapshot } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  currentChapterOf,
  SLOT_STATE_WORD,
  slotLabel,
  slotText,
  tocAriaLabel,
  tocEntry,
  tocParts,
  writtenCount,
} from './toc.ts';

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  const part = n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4;
  return {
    n,
    part: part as CatalogEntry['part'],
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 34 ? 'forward' : 'backward',
    ...overrides,
  };
}

const catalog = [
  ...Array.from({ length: 67 }, (_, index) => entry(index + 1)),
  // Override two slots: a titled chapter and an untitled written one.
].map((item) => {
  if (item.n === 1) return { ...item, title: 'Тестовая глава', written: true, rev: 1 };
  if (item.n === 2) return { ...item, title: null, written: true, rev: 2 };
  return item;
});

/** The live empty book: 67 slots, the two frame chapters carrying only their base sentence. */
const basisCatalog = catalog.map((item) => {
  if (item.n === 1) return entry(1, { basis: true });
  if (item.n === 2) return entry(2);
  if (item.n === 67) return entry(67, { basis: true });
  return item;
});

describe('slotLabel', () => {
  it('returns the title line verbatim and nothing when there is no title', () => {
    expect(slotLabel('Тестовая глава')).toBe('Тестовая глава');
    expect(slotLabel(null)).toBe('');
    expect(slotLabel('   ')).toBe('');
  });
});

describe('slotText', () => {
  it('uses the title line of a written chapter', () => {
    expect(slotText(entry(9, { title: 'Ночная смена', written: true }))).toBe('Ночная смена');
  });

  it('prints the frozen frame of a basis slot (BOOK-6)', () => {
    expect(slotText(entry(1, { basis: true }))).toBe(FRAME_FIRST_SENTENCE);
    expect(slotText(entry(67, { basis: true }))).toBe(FRAME_LAST_SENTENCE);
  });

  it('says «замысел» for a slot with no prose: the flow’s state word, never a title (BOOK-89)', () => {
    expect(slotText(entry(3))).toBe(SLOT_STATE_WORD);
    expect(slotText(entry(3))).toBe('замысел');
    // A basis flag outside the frame is not a sentence, and a written row with a broken title
    // line keeps its prose and says nothing — neither becomes a state word.
    expect(slotText(entry(8, { basis: true }))).toBeNull();
    expect(slotText(entry(9, { written: true, title: null }))).toBeNull();
  });
});

describe('tocEntry', () => {
  it('makes a link of a row that opens prose and leaves the rest inert', () => {
    expect(tocEntry(entry(1, { basis: true }), null, 1)).toMatchObject({
      n: 1,
      text: FRAME_FIRST_SENTENCE,
      link: true,
      href: '#ch-1',
    });
    // A written chapter with a broken title line keeps its prose reachable.
    expect(tocEntry(entry(2, { written: true, title: null }), null, 2)).toMatchObject({ text: null, link: true });
    // An empty slot carries the state word and its page, and stays inert.
    expect(tocEntry(entry(3), null, 3)).toMatchObject({ text: 'замысел', state: true, link: false, page: 3 });
  });

  it('never invents a label: the state word is a state, not a title', () => {
    const row = tocEntry(entry(3), null, 3);
    expect(row.title).toBeNull();
    expect(row.state).toBe(true);
    expect(row.text).toBe('замысел');
    expect(JSON.stringify(row)).not.toContain('Глава');
  });
});

describe('tocParts', () => {
  const parts = tocParts(catalog, 2);

  it('is exactly four parts with 67 entries in the fixed numbering', () => {
    expect(parts.map((part) => part.total)).toEqual([22, 22, 22, 1]);
    expect(parts.flatMap((part) => part.entries)).toHaveLength(67);
    expect(parts.map((part) => part.numeral)).toEqual(['I', 'II', 'III', 'IV']);
    expect(parts[3]?.entries[0]?.n).toBe(67);
  });

  it('carries the live title line and marks the chapter being written', () => {
    expect(parts[0]?.entries[0]).toMatchObject({
      n: 1,
      text: 'Тестовая глава',
      written: true,
      current: false,
      href: '#ch-1',
    });
    expect(parts[0]?.entries[1]).toMatchObject({ n: 2, text: null, written: true, current: true });
    expect(parts[0]?.entries[2]).toMatchObject({
      n: 3,
      text: 'замысел',
      state: true,
      written: false,
      link: false,
      current: false,
    });
  });

  it('carries the frame sentences at the head and the tail of the empty book', () => {
    const rows = tocParts(basisCatalog, null).flatMap((part) => part.entries);
    expect(rows).toHaveLength(67);
    expect(rows[0]).toMatchObject({ n: 1, text: FRAME_FIRST_SENTENCE, link: true });
    expect(rows[66]).toMatchObject({ n: 67, text: FRAME_LAST_SENTENCE, link: true });
    expect(rows.filter((row) => row.state)).toHaveLength(65);
    expect(rows.filter((row) => row.link)).toHaveLength(2);
  });

  it('counts the written rows per part', () => {
    expect(parts[0]?.written).toBe(2);
    expect(parts[1]?.written).toBe(0);
  });

  it('does not invent a part for a gap in the catalog', () => {
    const sparse = tocParts(
      catalog.filter((item) => item.n !== 23),
      null,
    );
    expect(sparse[1]?.entries).toHaveLength(21);
    expect(sparse[1]?.entries[0]?.n).toBe(24);
  });
});

describe('the row’s page (BOOK-89)', () => {
  it('equals chapterStartPages for all 67 rows — the TOC never counts a second time', () => {
    const starts = chapterStartPages(catalog);
    const rows = tocParts(catalog, null).flatMap((part) => part.entries);
    expect(rows).toHaveLength(67);
    for (const row of rows) expect(row.page).toBe(starts.get(row.n));
  });

  it('reads the same numbers for a book with prose: ch01 is page 1, a grown chapter moves the rest', () => {
    const grown = catalog.map((item) => (item.n === 5 ? { ...item, written: true, chars: 1801 } : item));
    const rows = tocParts(grown, null).flatMap((part) => part.entries);
    expect(rows[0]?.page).toBe(1);
    expect(rows[4]?.page).toBe(5); // ch05 grows to two pages, so ch06 starts at 7
    expect(rows[5]?.page).toBe(7);
    expect(rows[66]?.page).toBe(68);
    expect(rows[5]?.page).toBe(chapterStartPages(grown).get(6));
  });

  it('moves every following row by exactly one page when a chapter grows past a page', () => {
    const before = tocParts(catalog, null).flatMap((part) => part.entries).map((row) => row.page);
    const after = tocParts(catalog.map((item) => (item.n === 10 ? { ...item, chars: 1801 } : item)), null)
      .flatMap((part) => part.entries)
      .map((row) => row.page);
    // ch10 itself still opens on its own page; ch11 and everything after it moves by one.
    for (let index = 0; index < 10; index += 1) expect(after[index]).toBe(before[index]);
    for (let index = 10; index < 67; index += 1) expect(after[index]).toBe((before[index] ?? 0) + 1);
  });

  it('prints an empty chapter as the one page it occupies, with the state word', () => {
    const rows = tocParts(basisCatalog, null).flatMap((part) => part.entries);
    expect(rows[0]).toMatchObject({ n: 1, page: 1, link: true, state: false });
    expect(rows[1]).toMatchObject({ n: 2, page: 2, link: false, state: true, text: 'замысел' });
    expect(rows[66]).toMatchObject({ n: 67, page: 67, link: true });
  });
});

describe('state-derived helpers', () => {
  it('counts written chapters', () => {
    expect(writtenCount(catalog)).toBe(2);
    expect(writtenCount(catalog.map((item) => ({ ...item, written: false })))).toBe(0);
  });

  it('reads the caret chapter from the snapshot, never from a title caret', () => {
    const base = { current: { lane: 'forward', chapter: 8, kind: 'draft', blockId: null, blockIndex: null, since: '' } };
    expect(currentChapterOf(base as unknown as StateSnapshot)).toBe(8);
    expect(
      currentChapterOf({ current: { ...base.current, chapter: 'front', kind: 'front' } } as unknown as StateSnapshot),
    ).toBeNull();
    expect(currentChapterOf(null)).toBeNull();
    expect(currentChapterOf({ current: null } as unknown as StateSnapshot)).toBeNull();
  });

  it('has an accessible summary', () => {
    expect(tocAriaLabel(2, 67)).toBe('оглавление · написано 2 из 67');
  });
});
