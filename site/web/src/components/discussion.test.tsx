import { AUTHOR_COLORS, type CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Discussion } from './Discussion.tsx';

/** Every stylesheet as text: the ink classes are an invariant of the sheet, not of a snapshot. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

function render(comments: readonly CommentDto[]): string {
  return renderToStaticMarkup(<Discussion depth={0} chapterCount={10} comments={comments} />);
}

/** The ink rules a stylesheet declares: class slot → colour. */
function inkRules(css: string): Array<{ slot: string; color: string }> {
  return [...css.matchAll(/\.comment-author\.author-ink-(\d+)\s*\{\s*color:\s*(#[0-9a-f]{6});/gu)].map(
    (match) => ({ slot: match[1] ?? '', color: match[2] ?? '' }),
  );
}

/**
 * BOOK-30 — the author colour travels as a class per palette slot, never as a style
 * attribute: the markup holds no colour value, and a slot is themeable from the sheet.
 */
describe('the author ink on the thread', () => {
  it('gives two readers two different classes, and names no colour in the markup', () => {
    const html = render([
      comment({ id: 'cmt_1', author: 'Аня', authorColor: AUTHOR_COLORS[0] }),
      comment({ id: 'cmt_2', author: 'Борис', authorColor: AUTHOR_COLORS[1] }),
    ]);
    expect(html).toContain('class="comment-author author-ink-0"');
    expect(html).toContain('class="comment-author author-ink-1"');
    expect(html).toContain('>Аня<');
    expect(html).toContain('>Борис<');
    // No colour value and no style attribute anywhere in the rendered thread.
    expect(html).not.toMatch(/style=/u);
    for (const color of AUTHOR_COLORS) expect(html).not.toContain(color);
  });

  it('keeps a reader separated by name when the stored colour is unknown', () => {
    const html = render([
      comment({ id: 'cmt_1', author: 'Аня', authorColor: '#2e6274' }),
      comment({ id: 'cmt_2', author: 'Вера', authorColor: '#2e6274' }),
    ]);
    expect(html).toContain('class="comment-author author-ink-3"');
    expect(html).toContain('class="comment-author author-ink-2"');
    expect(html).toContain('>Аня<');
    expect(html).toContain('>Вера<');
  });

  it('has exactly one stylesheet rule per palette slot, with the palette colour', () => {
    const rules = Object.values(sheets).flatMap((css) => inkRules(css));
    expect(rules).toHaveLength(AUTHOR_COLORS.length);
    expect(rules.map((rule) => rule.slot)).toEqual(AUTHOR_COLORS.map((_, slot) => String(slot)));
    expect(rules.map((rule) => rule.color)).toEqual([...AUTHOR_COLORS]);
  });
});
