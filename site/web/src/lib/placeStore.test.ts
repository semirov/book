// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPlace, newerPlace, PLACE_KEY, readPlace, writePlace, clearPlace } from './placeStore.ts';
import type { Place } from './position.ts';

/**
 * BOOK-209 — the remembered place is one validated row. A malformed row, an old one and a
 * browser that refuses the store all read as **absent**: a place the page cannot trust must
 * never move the reader, and a private-mode `localStorage` that throws must never break a page.
 */

const place = (overrides: Partial<Place> = {}): Place => ({
  chapter: 12,
  sentenceId: 'ch12#aabbccdd/s140',
  deltaPx: 12.5,
  at: '2026-10-29T08:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('one validated row', () => {
  it('round-trips a place, and keeps exactly its four fields', () => {
    const kept = place();
    writePlace(kept);
    expect(readPlace()).toEqual(kept);
    expect(JSON.parse(window.localStorage.getItem(PLACE_KEY) ?? '{}')).toEqual(kept);
  });

  it('reads an absent store as no place', () => {
    expect(readPlace()).toBeNull();
  });

  it('reads a malformed or old row as absent, and never throws', () => {
    for (const raw of ['not json', '{}', 'null', '[]', '"ch12"']) {
      window.localStorage.setItem(PLACE_KEY, raw);
      expect(readPlace(), raw).toBeNull();
    }
  });

  it('refuses a row the wire would refuse: a chapter, a key, a delta and a full instant', () => {
    const refused: Array<Partial<Place>> = [
      { chapter: 0 },
      { chapter: 43 },
      { chapter: 4.5 },
      { sentenceId: '' },
      { sentenceId: 'ch12#aabbccdd/s1 и ещё' },
      { sentenceId: 'x'.repeat(201) },
      { deltaPx: Number.POSITIVE_INFINITY },
      { deltaPx: 10_001 },
      { at: '2026-10-29' },
      { at: '2026-10-29T08:00:00' },
      { at: 'не дата' },
    ];
    for (const overrides of refused) {
      const row = place(overrides);
      expect(isPlace(row), JSON.stringify(overrides)).toBe(false);
      // A row the module would refuse to read is refused on the way in as well.
      writePlace(row);
      expect(window.localStorage.getItem(PLACE_KEY), JSON.stringify(overrides)).toBeNull();
    }
    // The boundaries themselves are places.
    expect(isPlace(place({ chapter: 42 }))).toBe(true);
    expect(isPlace(place({ deltaPx: -10_000 }))).toBe(true);
    expect(isPlace(place({ at: '2026-10-29T08:00:00Z' }))).toBe(true);
    expect(isPlace(place({ at: '2026-10-29T08:00:00+03:00' }))).toBe(true);
  });

  it('reads a row that is not an object as absent', () => {
    for (const value of [null, 4, 'ch12', [], true]) expect(isPlace(value), String(value)).toBe(false);
  });

  it('replaces the one row and forgets it when asked', () => {
    writePlace(place());
    writePlace(place({ chapter: 13, sentenceId: 'ch13' }));
    expect(readPlace()).toMatchObject({ chapter: 13 });
    clearPlace();
    expect(readPlace()).toBeNull();
    // Forgetting twice is not an error.
    clearPlace();
  });

  it('survives a store that throws: a private-mode browser is not a broken page', () => {
    const native = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(readPlace()).toBeNull();
      expect(() => writePlace(place())).not.toThrow();
      expect(() => clearPlace()).not.toThrow();
    } finally {
      if (native !== undefined) Object.defineProperty(window, 'localStorage', native);
    }
  });

  it('survives a store that refuses the write (a full quota) and the removal', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writePlace(place())).not.toThrow();
    expect(readPlace()).toBeNull();
    setItem.mockRestore();

    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => clearPlace()).not.toThrow();
    removeItem.mockRestore();
  });
});

describe('the newer of two rows', () => {
  const older = place({ at: '2026-10-29T08:00:00.000Z', chapter: 3 });
  const newer = place({ at: '2026-10-29T09:30:00.000Z', chapter: 9 });

  it('takes the later instant, in either order', () => {
    expect(newerPlace(older, newer)?.chapter).toBe(9);
    expect(newerPlace(newer, older)?.chapter).toBe(9);
  });

  it('keeps the server’s row when the two agree to the millisecond', () => {
    expect(newerPlace(older, place({ at: older.at, chapter: 11 }))?.chapter).toBe(11);
  });

  it('answers the one row there is, and nothing when there is none', () => {
    expect(newerPlace(null, newer)).toBe(newer);
    expect(newerPlace(newer, null)).toBe(newer);
    expect(newerPlace(null, null)).toBeNull();
  });
});
