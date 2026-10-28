import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { directionOf, FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, partOf, type CatalogEntry } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChapterArticle } from './ChapterArticle.tsx';

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
    direction: directionOf(n),
    ...overrides,
  };
}

function render(row: CatalogEntry): string {
  return renderToStaticMarkup(
    <ChapterArticle entry={row} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />,
  );
}

/** The text a reader sees, without the sentence anchors that make the prose tappable. */
function prose(html: string): string {
  return html.replace(/<[^>]+>/gu, '');
}

describe('a chapter slot on the reading page (§11.2, BOOK-6, BOOK-70)', () => {
  it('reads a basis-only chapter as its frozen sentence, with no state label in the header', () => {
    const html = render(entry(1, { basis: true, blocks: 1 }));
    expect(prose(html)).toContain(FRAME_FIRST_SENTENCE);
    expect(html).not.toContain('не написана');
    expect(html).not.toContain('ch-empty');
    expect(html).toContain('data-basis="true"');
  });

  it('closes the book with the last sentence in the same way', () => {
    const html = render(entry(42, { basis: true, blocks: 1 }));
    expect(prose(html)).toContain(FRAME_LAST_SENTENCE);
    expect(html).not.toContain('не написана');
    // Chapter 42 is drafted backwards; its slot shows the same header as any other, no arrow.
    expect(html).not.toContain('←');
    expect(html).toContain('data-basis="true"');
  });

  it('renders an untouched slot as one row: a numeral, the leader — no heading, no state word', () => {
    // BOOK-90 A: the empty chapter is one row in the flow; the big `ch-n`, the meta line and
    // «не написана» are gone, and the numeral appears exactly once. BOOK-112 takes the word.
    const html = render(entry(2));
    expect(html).toContain('ch-empty');
    expect(html).toContain('class="premise-row"');
    expect(html).toContain('02');
    expect(html).not.toContain('замысел');
    expect(html).not.toContain('class="ch-h"');
    expect(html).not.toContain('class="ch-n"');
    expect(html).not.toContain('не написана');
    expect(html).not.toContain(FRAME_FIRST_SENTENCE);
    expect(html).not.toContain('data-basis');
  });

  it('does not print the frame for a written chapter, and reserves its place without a style attribute', () => {
    // BOOK-30: the slot's height is a CSSOM write on mount, so the markup carries no style
    // attribute; `chapterArticle.dom.test.tsx` proves the write lands in a browser.
    const html = render(entry(1, { written: true, basis: false, chars: 22_628, blocks: 180, title: 'Тестовая глава' }));
    expect(html).not.toContain(FRAME_FIRST_SENTENCE);
    expect(html).not.toContain('не написана');
    expect(html).not.toContain('ch-empty');
    expect(html).toContain('Тестовая глава');
    expect(html).toContain('class="ch-placeholder"');
    expect(html).not.toMatch(/style=/u);
  });

  it('splits the header meta into a state chip and a data line, and the data is a written fact', () => {
    const written = render(entry(3, { written: true, chars: 9_003, updatedAt: '2026-10-25T09:52:00Z' }));
    expect(written).toContain('class="ch-data"');
    expect(written).toContain('9\u00a0003\u00a0знака · 12:52');
    // «печатается» belongs to the printing chapter: it is not in the markup on a first paint.
    expect(written).not.toContain('ch-print');

    const unwritten = render(entry(4, { chars: 9_003, updatedAt: '2026-10-25T09:52:00Z' }));
    // BOOK-90 A: an empty chapter is one row — no header, no data line to date nothing.
    expect(unwritten).not.toContain('ch-data');
    expect(unwritten).not.toContain('ch-meta');
    expect(unwritten).toContain('class="premise-row"');
  });
});
