import {
  chapterStartPages,
  FRAME_FIRST_SENTENCE,
  FRAME_LAST_SENTENCE,
  partOf,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type StateSnapshot,
} from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  currentChapterOf,
  slotLabel,
  slotText,
  tocAriaLabel,
  tocEntry,
  tocFrames,
  tocParts,
  writtenCount,
  type TocEntryView,
} from './toc.ts';

const LAST = TOTAL_CHAPTERS;

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: partOf(n),
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 21 ? 'forward' : 'backward',
    ...overrides,
  };
}

const catalog = [
  ...Array.from({ length: TOTAL_CHAPTERS }, (_, index) => entry(index + 1)),
  // Override two slots: a titled chapter and an untitled written one.
].map((item) => {
  if (item.n === 1) return { ...item, title: 'Тестовая глава', written: true, rev: 1 };
  if (item.n === 2) {
    return { ...item, title: null, written: true, rev: 2, opening: 'Он вошёл в комнату и закрыл…' };
  }
  return item;
});

/** The live empty book: 42 slots, the two frame chapters carrying only their base sentence. */
const basisCatalog = catalog.map((item) => {
  if (item.n === 1) return entry(1, { basis: true });
  if (item.n === 2) return entry(2);
  if (item.n === LAST) return entry(LAST, { basis: true });
  return item;
});

/** The rows the contents prints, in order: the opening, four parts of ten, the finale. */
function rowsOf(source: readonly CatalogEntry[], current: number | null = null): TocEntryView[] {
  const frames = tocFrames(source, current);
  return [
    ...(frames.opening === null ? [] : [frames.opening]),
    ...tocParts(source, current).flatMap((part) => part.entries),
    ...(frames.finale === null ? [] : [frames.finale]),
  ];
}

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
    expect(slotText(entry(LAST, { basis: true }))).toBe(FRAME_LAST_SENTENCE);
  });

  it('names an empty slot «Пусто» — one word, nothing else (owner, 2026-10-28)', () => {
    expect(slotText(entry(3))).toBe('Пусто');
    // A basis flag outside the frame is not a sentence: the slot holds no prose of its own.
    expect(slotText(entry(8, { basis: true }))).toBe('Пусто');
  });

  it('shows the first five words of a written chapter with no title line — never a state', () => {
    // BOOK-137 put «написана» here; the owner's correction (2026-10-28) called it what it was:
    // a status word standing where a title belongs. The row shows the book's own prose.
    expect(slotText(entry(9, { written: true, title: null, opening: 'Свет был не для меня…' }))).toBe(
      'Свет был не для меня…',
    );
    expect(slotText(entry(9, { written: true, title: '  ', opening: 'Свет был не для меня…' }))).toBe(
      'Свет был не для меня…',
    );
    // Its own title line wins whenever there is one.
    expect(slotText(entry(9, { written: true, title: 'Ночная смена', opening: 'Свет был не для меня…' }))).toBe(
      'Ночная смена',
    );
    // The frozen slot keeps its frame sentence, never the excerpt and never a word of state.
    expect(slotText(entry(LAST, { basis: true, opening: FRAME_LAST_SENTENCE }))).toBe(FRAME_LAST_SENTENCE);
    // Nothing in the decision prints a status word.
    for (const row of [entry(3), entry(9, { written: true }), entry(LAST, { basis: true })]) {
      expect(String(slotText(row))).not.toMatch(/написан|замысел|ждёт/iu);
    }
  });
});

describe('tocEntry', () => {
  it('makes every row a link — an empty slot included (owner, 2026-10-28)', () => {
    expect(tocEntry(entry(1, { basis: true }), null, 1)).toMatchObject({
      n: 1,
      text: FRAME_FIRST_SENTENCE,
      link: true,
      empty: false,
      href: '#ch-1',
    });
    // A written chapter with no title line keeps its prose reachable and shows its opening.
    expect(tocEntry(entry(2, { written: true, title: null, opening: 'Свет был не для меня…' }), null, 2)).toMatchObject({
      text: 'Свет был не для меня…',
      link: true,
      empty: false,
    });
    // An empty slot carries one word and an anchor of its own: a tap opens its place, not nothing.
    expect(tocEntry(entry(3), null, 3)).toMatchObject({ text: 'Пусто', link: true, empty: true, page: 3 });
  });

  it('never invents a label: an empty row carries «Пусто» and no title', () => {
    const row = tocEntry(entry(3), null, 3);
    expect(row.title).toBeNull();
    expect(row.text).toBe('Пусто');
    expect(JSON.stringify(row)).not.toContain('Глава');
    expect(JSON.stringify(row)).not.toContain('замысел');
    expect(JSON.stringify(row)).not.toContain('написана');
  });
});

describe('tocParts', () => {
  const parts = tocParts(catalog, 2);

  it('is exactly four parts of ten chapters in the fixed numbering', () => {
    expect(parts.map((part) => part.total)).toEqual([10, 10, 10, 10]);
    expect(parts.map((part) => [part.from, part.to])).toEqual([
      [2, 11],
      [12, 21],
      [22, 31],
      [32, 41],
    ]);
    expect(parts.flatMap((part) => part.entries)).toHaveLength(TOTAL_CHAPTERS - 2);
    expect(parts.map((part) => part.numeral)).toEqual(['I', 'II', 'III', 'IV']);
    expect(parts[0]?.entries[0]?.n).toBe(2);
    expect(parts[3]?.entries.at(-1)?.n).toBe(TOTAL_CHAPTERS - 1);
  });

  it('carries the live title line and marks the chapter being written', () => {
    // Part I opens on ch02: ch01 is the opening, printed outside the parts (BOOK-155).
    expect(parts[0]?.entries[0]).toMatchObject({
      n: 2,
      text: 'Он вошёл в комнату и закрыл…',
      written: true,
      current: true,
      href: '#ch-2',
    });
    expect(parts[0]?.entries[1]).toMatchObject({
      n: 3,
      text: 'Пусто',
      written: false,
      link: true,
      empty: true,
      current: false,
    });
    // The titled chapter stands in the opening row, not in a part.
    expect(tocFrames(catalog, 2).opening).toMatchObject({ n: 1, text: 'Тестовая глава', current: false });
  });

  it('carries the frame sentences at the head and the tail of the empty book', () => {
    const rows = rowsOf(basisCatalog);
    expect(rows).toHaveLength(TOTAL_CHAPTERS);
    expect(rows[0]).toMatchObject({ n: 1, text: FRAME_FIRST_SENTENCE, link: true });
    expect(rows.at(-1)).toMatchObject({ n: LAST, text: FRAME_LAST_SENTENCE, link: true });
    // The two frames carry the book's own text; every other row says «Пусто», and every row
    // opens its chapter — there is no inert row (owner, 2026-10-28).
    expect(rows.filter((row) => row.text === FRAME_FIRST_SENTENCE || row.text === FRAME_LAST_SENTENCE)).toHaveLength(2);
    expect(rows.filter((row) => row.text === 'Пусто')).toHaveLength(40);
    expect(rows.filter((row) => row.link)).toHaveLength(TOTAL_CHAPTERS);
    expect(rows.filter((row) => row.empty)).toHaveLength(40);
  });

  it('counts the written rows per part', () => {
    expect(parts[0]?.written).toBe(1);
    expect(parts[1]?.written).toBe(0);
  });

  it('does not invent a part for a gap in the catalog', () => {
    const sparse = tocParts(
      catalog.filter((item) => item.n !== 23),
      null,
    );
    expect(sparse[2]?.entries).toHaveLength(9);
    expect(sparse[2]?.entries[0]?.n).toBe(22);
  });
});

describe('tocFrames (BOOK-155)', () => {
  it('gives the two frames the same row shape as a part, with the basis sentence', () => {
    const frames = tocFrames(basisCatalog, null);
    expect(frames.opening).toMatchObject({
      n: 1,
      text: FRAME_FIRST_SENTENCE,
      link: true,
      current: false,
      href: '#ch-1',
    });
    expect(frames.finale).toMatchObject({
      n: LAST,
      text: FRAME_LAST_SENTENCE,
      link: true,
      current: false,
      href: `#ch-${LAST}`,
    });
  });

  it('reads the frame page from the one chapterStartPages count', () => {
    const starts = chapterStartPages(catalog);
    expect(tocFrames(catalog, null).opening?.page).toBe(starts.get(1));
    expect(tocFrames(catalog, null).finale?.page).toBe(starts.get(LAST));
  });

  it('marks the caret chapter when the writer stands in a frame', () => {
    expect(tocFrames(catalog, 1).opening?.current).toBe(true);
    expect(tocFrames(catalog, LAST).finale?.current).toBe(true);
    expect(tocFrames(catalog, 5).finale?.current).toBe(false);
  });

  it('invents no row for a frame the catalog does not have', () => {
    const headless = catalog.filter((item) => item.n !== 1 && item.n !== LAST);
    expect(tocFrames(headless, null)).toEqual({ opening: null, finale: null });
  });
});

describe('the contents of the whole book (BOOK-155)', () => {
  it('is 42 rows in order: the opening first, four parts of ten, the finale last', () => {
    const frames = tocFrames(basisCatalog, null);
    const parts = tocParts(basisCatalog, null);
    const rows = rowsOf(basisCatalog);

    // One row per chapter, numbered 1..42 in reading order: no gap, no repeat (the acceptance).
    expect(rows).toHaveLength(TOTAL_CHAPTERS);
    expect(rows.map((row) => row.n)).toEqual(Array.from({ length: TOTAL_CHAPTERS }, (_, i) => i + 1));
    expect(rows[0]?.n).toBe(1);
    expect(rows.at(-1)?.n).toBe(LAST);

    // The two frames are outside the parts, and the four parts hold exactly ten each.
    expect(frames.opening?.n).toBe(1);
    expect(frames.finale?.n).toBe(LAST);
    expect(parts.map((part) => part.entries.length)).toEqual([10, 10, 10, 10]);
    expect(parts.flatMap((part) => part.entries).map((row) => row.n)).toEqual(
      Array.from({ length: TOTAL_CHAPTERS - 2 }, (_, i) => i + 2),
    );
    // No chapter is both a frame and a part row.
    expect(parts.flatMap((part) => part.entries).map((row) => row.n)).not.toContain(1);
    expect(parts.flatMap((part) => part.entries).map((row) => row.n)).not.toContain(LAST);
  });
});

describe('the row’s page (BOOK-89)', () => {
  it('equals chapterStartPages for all 42 rows — the TOC never counts a second time', () => {
    const starts = chapterStartPages(catalog);
    const rows = rowsOf(catalog);
    expect(rows).toHaveLength(TOTAL_CHAPTERS);
    for (const row of rows) expect(row.page).toBe(starts.get(row.n));
  });

  it('reads the same numbers for a book with prose: ch01 is page 1, a grown chapter moves the rest', () => {
    const grown = catalog.map((item) => (item.n === 5 ? { ...item, written: true, chars: 1801 } : item));
    const rows = rowsOf(grown);
    expect(rows[0]?.page).toBe(1);
    expect(rows[4]?.page).toBe(5); // ch05 grows to two pages, so ch06 starts at 7
    expect(rows[5]?.page).toBe(7);
    // Every one of the 42 chapters is one page, plus the extra page ch05 takes.
    expect(rows.at(-1)?.page).toBe(TOTAL_CHAPTERS + 1);
    expect(rows[5]?.page).toBe(chapterStartPages(grown).get(6));
  });

  it('moves every following row by exactly one page when a chapter grows past a page', () => {
    const before = rowsOf(catalog).map((row) => row.page);
    const after = rowsOf(catalog.map((item) => (item.n === 10 ? { ...item, chars: 1801 } : item))).map(
      (row) => row.page,
    );
    // ch10 itself still opens on its own page; ch11 and everything after it moves by one.
    for (let index = 0; index < 10; index += 1) expect(after[index]).toBe(before[index]);
    for (let index = 10; index < TOTAL_CHAPTERS; index += 1) {
      expect(after[index]).toBe((before[index] ?? 0) + 1);
    }
  });

  it('prints an empty chapter as the one page it occupies, with the one word «Пусто»', () => {
    const rows = rowsOf(basisCatalog);
    expect(rows[0]).toMatchObject({ n: 1, page: 1, link: true, text: FRAME_FIRST_SENTENCE });
    expect(rows[1]).toMatchObject({ n: 2, page: 2, link: true, empty: true, text: 'Пусто' });
    expect(rows.at(-1)).toMatchObject({ n: LAST, page: LAST, link: true });
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
    expect(tocAriaLabel(2, TOTAL_CHAPTERS)).toBe('оглавление · написано 2 из 42');
  });
});
