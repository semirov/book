import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CHAPTER_WIDTHS, SKELETON_LINES, type SkeletonVariant } from '../lib/skeleton.ts';
import { Skeleton } from './Skeleton.tsx';

/**
 * BOOK-DOC-43 §3, §7 — the shape is markup, not a picture (BOOK-66).
 *
 * A placeholder that carried a word, a label, a `tabindex` or a `style` attribute would pass
 * any "does it look right" review and still be wrong: the bars are decoration, so they are
 * `aria-hidden`, empty and inert. Counts and widths come from data attributes only.
 */

const VARIANTS: readonly SkeletonVariant[] = ['chapter', 'register', 'chronicle', 'authors', 'chain'];

function markup(variant: SkeletonVariant): string {
  return renderToStaticMarkup(<Skeleton variant={variant} />);
}

function count(html: string, pattern: RegExp): number {
  return [...html.matchAll(pattern)].length;
}

/** The text a reader would get, with every tag removed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/gu, '');
}

describe('a skeleton is a form with blank fields', () => {
  it('draws the chapter as 8 empty bars in 3 / 3 / 2 paragraphs, ragged in §3 order', () => {
    const html = markup('chapter');
    expect(html).toContain('class="skel skel-chapter"');
    expect(html).toContain('data-lines="8"');
    expect(html).toContain('aria-hidden="true"');
    expect(count(html, /<p class="skel-p">/gu)).toBe(3);
    expect(count(html, /<span class="skel-line"/gu)).toBe(8);
    const widths = [...html.matchAll(/data-w="(\d)"/gu)].map((match) => Number(match[1]));
    expect(widths).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(widths.map((index) => CHAPTER_WIDTHS[index - 1])).toEqual([94, 88, 62, 97, 91, 55, 90, 68]);
    expect(text(html)).toBe('');
  });

  it('gives every variant a counted wrapper, hidden from assistive tech, with no bar text', () => {
    for (const variant of VARIANTS) {
      const html = markup(variant);
      const total = SKELETON_LINES[variant].reduce((sum, lines) => sum + lines, 0);
      expect(html, variant).toContain(`class="skel skel-${variant}"`);
      expect(html, variant).toContain(`data-${variant === 'chapter' ? 'lines' : 'rows'}="${total}"`);
      expect(html, variant).toContain('aria-hidden="true"');
      expect(html, variant).not.toMatch(/style=|tabindex|role=|aria-label|<button|<a /u);
      // Only the «Авторы» share column prints anything, and it prints the honest unknown.
      expect(text(html).replace(/—/gu, ''), variant).toBe('');
    }
  });

  it('keeps three rows on each list surface, and «—» where the share is unknown', () => {
    for (const variant of ['register', 'chronicle', 'authors', 'chain'] as const) {
      const html = markup(variant);
      expect(count(html, /class="skel-row"/gu), variant).toBe(3);
    }
    expect(markup('authors')).toContain('class="skel-share">—<');
    // The chronicle carries its day label above the rows: the shape of a day, not row 4.
    expect(markup('chronicle')).toContain('skel-day');
  });
});
