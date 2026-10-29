import { describe, expect, it } from 'vitest';

import { AUTHOR_COLORS, authorColor } from '../src/comment.ts';

/**
 * BOOK-30 — a reader's stored colour is a palette slot, and it stays on the wire.
 *
 * BOOK-199 (audit #21): the book no longer paints it — six colours for six readers measured
 * 1.98–2.41:1 on the day paper, and identity belongs to the name. What remains here is the one
 * thing the server still needs: a stable, in-palette value per reader, derived from the name.
 */

describe('the stored author colour (§11.6, BOOK-30)', () => {
  it('keeps a reader on the same value across calls and inside the palette', () => {
    const first = authorColor('Аня');
    expect(authorColor('Аня')).toBe(first);
    expect(AUTHOR_COLORS).toContain(first);
  });

  it('gives different readers different values', () => {
    expect(authorColor('Аня')).not.toBe(authorColor('Вера'));
  });

  it('states the palette once, as values the wire may carry', () => {
    expect(new Set(AUTHOR_COLORS).size).toBe(AUTHOR_COLORS.length);
    for (const color of AUTHOR_COLORS) expect(color).toMatch(/^#[0-9a-f]{6}$/u);
  });
});
