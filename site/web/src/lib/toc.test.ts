import type { CatalogEntry, StateSnapshot, TocEntry } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  currentChapterOf,
  fromStateToc,
  slotLabel,
  tocAriaLabel,
  tocHeading,
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
  if (item.n === 1) return { ...item, title: 'Половик в тамбуре', written: true, rev: 1 };
  if (item.n === 2) return { ...item, title: null, written: true, rev: 2 };
  return item;
});

describe('slotLabel', () => {
  it('uses the title line, or the slot label when empty or untitled', () => {
    expect(slotLabel(1, 'Половик в тамбуре')).toBe('Половик в тамбуре');
    expect(slotLabel(9, null)).toBe('Глава 9');
    expect(slotLabel(9, '   ')).toBe('Глава 9');
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

  it('carries the live title and marks the chapter being written', () => {
    expect(parts[0]?.entries[0]).toMatchObject({
      n: 1,
      label: 'Половик в тамбуре',
      written: true,
      current: false,
      href: '#ch-1',
    });
    expect(parts[0]?.entries[1]).toMatchObject({ n: 2, label: 'Глава 2', written: true, current: true });
    expect(parts[0]?.entries[2]).toMatchObject({ n: 3, label: 'Глава 3', written: false, current: false });
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

  it('uses the live title as the TOC heading', () => {
    expect(
      tocHeading({ front: { title: 'Земля, которая больше не кормит' } } as unknown as StateSnapshot),
    ).toBe('Земля, которая больше не кормит');
  });

  it('maps the server TOC without dropping entries', () => {
    const toc: TocEntry[] = [
      { part: 1, n: 1, title: 'Начало', written: true, rev: 1 },
      { part: 1, n: 2, title: null, written: false, rev: 0 },
    ];
    expect(fromStateToc(toc, 1).map((item) => item.label)).toEqual(['Начало', 'Глава 2']);
    expect(fromStateToc(toc, 1)[0]?.current).toBe(true);
  });

  it('has an accessible summary', () => {
    expect(tocAriaLabel(2, 67)).toBe('оглавление · написано 2 из 67');
  });
});
