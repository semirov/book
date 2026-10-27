import type { CatalogEntry } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { frozenReasonOf, isFrozenChapter } from './freeze.ts';

describe('a frozen chapter (BOOK-33)', () => {
  const entry = (n: number, overrides: Partial<CatalogEntry> = {}): Pick<CatalogEntry, 'n' | 'basis'> => ({ n, basis: false, ...overrides });

  it('freezes ch01 and ch67 even when they are written', () => {
    // The BOOK-32 shape: a written ch01 (frame + prose). The server answers FROZEN_FRAME.
    expect(isFrozenChapter(entry(1))).toBe(true);
    expect(isFrozenChapter(entry(67))).toBe(true);
    expect(isFrozenChapter(entry(1, { basis: true }))).toBe(true);
  });

  it('leaves every other chapter open, including its premise slots', () => {
    expect(isFrozenChapter(entry(2))).toBe(false);
    expect(isFrozenChapter(entry(8))).toBe(false);
    expect(isFrozenChapter(entry(66))).toBe(false);
  });

  it('names why a frozen strip is frozen', () => {
    expect(frozenReasonOf(entry(1))).toBe('frame');
    expect(frozenReasonOf(entry(67))).toBe('frame');
    // Page 2 carries the basis wording rather than the frame's: the panel says «основание».
    expect(frozenReasonOf(entry(0, { basis: true }))).toBe('basis');
  });
});
