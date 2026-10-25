import type { CatalogEntry } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { groupSlots, runLabel } from './inventory.ts';

function entry(n: number, written: boolean): CatalogEntry {
  return {
    n,
    rev: written ? 1 : 0,
    chars: written ? 9000 : 0,
    blocks: written ? 120 : 0,
    written,
    writtenAt: written ? '2026-10-25T09:00:00Z' : null,
    updatedAt: written ? '2026-10-25T09:00:00Z' : null,
    direction: n <= 34 ? 'forward' : 'backward',
    line: 0,
  };
}

function catalog(written: number[]): CatalogEntry[] {
  const set = new Set(written);
  return Array.from({ length: 67 }, (_, index) => entry(index + 1, set.has(index + 1)));
}

describe('groupSlots', () => {
  it('shows every blank field on day one', () => {
    const rows = groupSlots(catalog([]));
    expect(rows).toHaveLength(67);
    expect(rows.every((row) => row.kind === 'empty')).toBe(true);
  });

  it('collapses a long empty run into one summary row', () => {
    const rows = groupSlots(catalog([1, 2, 66, 67]));
    expect(rows.map((row) => row.kind)).toEqual(['written', 'written', 'run', 'written', 'written']);
    expect(rows[2]).toMatchObject({ kind: 'run', from: 3, to: 65, count: 63 });
  });

  it('keeps short runs as individual rows', () => {
    const written = Array.from({ length: 63 }, (_, index) => index + 1);
    const rows = groupSlots(catalog([...written, 67]));
    expect(rows.filter((row) => row.kind === 'run')).toHaveLength(0);
    expect(rows.filter((row) => row.kind === 'empty')).toHaveLength(3);
  });

  it('expands a run the reader asked for', () => {
    const rows = groupSlots(catalog([1, 2, 66, 67]), { expanded: new Set(['3-65']) });
    expect(rows.filter((row) => row.kind === 'run')).toHaveLength(0);
    expect(rows.filter((row) => row.kind === 'empty')).toHaveLength(63);
  });

  it('keeps the book order for a partial manuscript', () => {
    const rows = groupSlots(catalog([1, 5, 34, 35]));
    const written = rows.filter((row) => row.kind === 'written').map((row) => (row.kind === 'written' ? row.entry.n : 0));
    expect(written).toEqual([1, 5, 34, 35]);
  });

  it('returns nothing for an empty catalog', () => {
    expect(groupSlots([])).toEqual([]);
  });
});

describe('runLabel', () => {
  it('zero-pads both ends', () => {
    expect(runLabel(10, 65)).toBe('10—65');
    expect(runLabel(3, 9)).toBe('03—09');
  });
});
