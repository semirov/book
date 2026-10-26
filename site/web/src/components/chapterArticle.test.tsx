import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, type CatalogEntry } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChapterArticle } from './ChapterArticle.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: (n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4) as CatalogEntry['part'],
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

function render(row: CatalogEntry): string {
  return renderToStaticMarkup(
    <ChapterArticle entry={row} revision={null} revising={null} caret={null} fresh={false} />,
  );
}

describe('a chapter slot on the reading page (§11.2, BOOK-6)', () => {
  it('reads a basis-only chapter as its frozen sentence, with no «не написана» label', () => {
    const html = render(entry(1, { basis: true, blocks: 1 }));
    expect(html).toContain(FRAME_FIRST_SENTENCE);
    expect(html).not.toContain('не написана');
    expect(html).not.toContain('ch-empty');
    expect(html).toContain('data-basis="true"');
  });

  it('closes the book with the last sentence in the same way', () => {
    const html = render(entry(67, { basis: true, blocks: 1 }));
    expect(html).toContain(FRAME_LAST_SENTENCE);
    expect(html).not.toContain('не написана');
    // Chapter 67 is drafted backwards, so its slot carries the lane arrow.
    expect(html).toContain('data-basis="true"');
  });

  it('renders an untouched slot as today: a slim empty article, no prose', () => {
    const html = render(entry(2));
    expect(html).toContain('ch-empty');
    expect(html).toContain('не написана');
    expect(html).not.toContain(FRAME_FIRST_SENTENCE);
    expect(html).not.toContain('data-basis');
  });

  it('does not print the frame for a written chapter, and carries the catalog characters', () => {
    // A written slot renders a placeholder sized from the viewport before its prose arrives.
    vi.stubGlobal('window', { innerWidth: 390 });
    const html = render(entry(1, { written: true, basis: false, chars: 22_628, blocks: 180, title: 'Тестовая глава' }));
    expect(html).not.toContain(FRAME_FIRST_SENTENCE);
    expect(html).not.toContain('не написана');
    expect(html).not.toContain('ch-empty');
    expect(html).toContain('Тестовая глава');
  });
});
