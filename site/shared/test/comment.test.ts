import { describe, expect, it } from 'vitest';

import { AUTHOR_COLORS, authorColor, authorInkClass, authorInkIndex, commentInkClass } from '../src/comment.ts';

/**
 * BOOK-30 — a reader's ink is a palette slot, and the slot is all the markup may name.
 *
 * The markup carries no colour value at all; the class is the only ink, and the mapping
 * below is its one source.
 */

describe('the author ink palette (§11.6, BOOK-30)', () => {
  it('keeps a reader on the same slot across calls and inside the palette', () => {
    const first = authorColor('Аня');
    expect(authorColor('Аня')).toBe(first);
    expect(AUTHOR_COLORS).toContain(first);
  });

  it('gives different readers different slots', () => {
    expect(authorColor('Аня')).not.toBe(authorColor('Вера'));
  });

  it('names a palette slot, never a colour or a bare index', () => {
    expect(authorInkClass(AUTHOR_COLORS[0])).toBe('author-ink-0');
    expect(authorInkClass(AUTHOR_COLORS[3])).toBe('author-ink-3');
    expect(authorInkClass(AUTHOR_COLORS[3])).not.toContain('#');
    expect(authorInkIndex('не цвет')).toBe(0);
    expect(authorInkClass('не цвет')).toBe('author-ink-0');
  });

  it('has one class per palette slot and no more', () => {
    const classes = new Set(AUTHOR_COLORS.map((color) => authorInkClass(color)));
    expect(classes.size).toBe(AUTHOR_COLORS.length);
    expect([...classes]).toEqual(AUTHOR_COLORS.map((_, slot) => `author-ink-${slot}`));
  });

  it('falls back to the reader own slot for a stored colour it does not know', () => {
    expect(commentInkClass('Аня', '#2e6274')).toBe(authorInkClass(authorColor('Аня')));
    expect(commentInkClass('Аня', '#2e6274')).not.toBe(commentInkClass('Вера', '#2e6274'));
    expect(commentInkClass('Аня', AUTHOR_COLORS[1])).toBe('author-ink-1');
  });
});
