import type { CatalogEntry } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-90 A — the empty chapter is one row, once.
 *
 * One numeral, one dotted field — or the premise's own quote; no `ch-h`, no big `ch-n`, no
 * meta line, and **no explanation sentence**: BOOK-112 takes the interface's words off the
 * reading surface, so the flow prints the book's numbers and the reader's words alone.
 */

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
}

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: 1,
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: 'forward',
    ...overrides,
  };
}

function article(row: CatalogEntry, firstEmpty = false): string {
  return renderToStaticMarkup(
    <ChapterArticle
      entry={row}
      revision={null}
      revising={null}
      caret={null}
      fresh={false}
      firstEmpty={firstEmpty}
      history
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: false, displayName: null }}
    />,
  );
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('one row, one numeral, no interface copy', () => {
  it('renders no heading and exactly one numeral per empty chapter', () => {
    const html = [article(entry(3), true), article(entry(4)), article(entry(5))].join('\n');
    expect(count(html, 'class="premise-n"')).toBe(3);
    expect(count(html, 'class="ch-n"')).toBe(0);
    expect(html).not.toContain('class="ch-h"');
    expect(html).not.toContain('ch-meta');
    expect(html).not.toContain('не написана');
  });

  it('prints no explanation sentence and no state word in the flow, first empty chapter or not', () => {
    const html = [article(entry(3), true), article(entry(4)), article(entry(5))].join('\n');
    expect(html).not.toContain('class="premise-hint"');
    expect(html).not.toContain('class="premise-label"');
    expect(html).not.toContain('замысел');
  });

  it('orders the row numeral → leader, and the leader is the field', () => {
    const html = article(entry(7), true);
    const numeral = html.indexOf('class="premise-n"');
    const leader = html.indexOf('class="premise-field premise-leader"');
    expect(numeral).toBeGreaterThan(-1);
    expect(leader).toBeGreaterThan(numeral);
    expect(html).toContain('aria-label="глава 7"');
  });

  it('never lifts the chapter title or a state word into the row', () => {
    const titled = article(entry(7, { title: 'Перевод смены' }));
    expect(titled).not.toContain('Перевод смены');
    expect(titled).not.toContain('замысел');
    expect(article(entry(8))).toContain('class="premise-field premise-leader"');
  });
});

describe('the row’s geometry is the prose’s geometry', () => {
  it('ends the row’s content on the prose edge without sizing the box by the measure', () => {
    // BOOK-88's one rule: `--measure` never sizes a box. The `.toc-line` inset is the
    // sanctioned way for a full-width row to close on the prose's right edge.
    const row = declarations(sheets['../styles/seam-form.css'] ?? '', '.premise-row');
    expect(row).not.toContain('max-width');
    expect(row).toContain('padding-inline-end: max(0px, calc(100% - var(--measure)))');
    // The hit area stays the column's whole width; only its content ends on the prose edge.
    expect(row).toContain('width: 100%');
    expect(row).toContain('grid-template-columns: auto minmax(0, 1fr)');
    expect(row).toContain('min-height: 44px');
    // The numeral is the mono micro rung, tabular.
    expect(declarations(sheets['../styles/seam-form.css'] ?? '', '.premise-n')).toContain('font-variant-numeric: tabular-nums');
    // BOOK-112: no state slot is left in the sheet.
    expect(sheets['../styles/seam-form.css'] ?? '').not.toContain('.premise-label');
    expect(sheets['../styles/seam-form.css'] ?? '').not.toContain('.premise-hint');
    // No second heading rule is left for the empty slot.
    expect(sheets['../styles/live.css'] ?? '').not.toContain('.ch-empty .ch-n');
    expect(sheets['../styles/live.css'] ?? '').not.toContain('.ch-empty .ch-h');
  });

  it('gives the opened strip the seam’s rhythm in an empty chapter: 8 above, 12 below', () => {
    // BOOK-90 A.6: the strip is an inserted row, not a collision — it takes flow space and air.
    const seam = declarations(sheets['../styles/seam.css'] ?? '', '.ch-empty .seam');
    expect(seam).toContain('display: block');
    expect(seam).toContain('margin: 8px 0 12px');
    // The next slot does not add its own top air on top of the strip's 12 px margin.
    expect(sheets['../styles/seam.css'] ?? '').toMatch(/\.ch-empty:has\(> \.seam\) \+ \.ch-empty \{[^}]*padding-top: 0/u);
  });

  it('draws the field as a dotted leader that ends the row, with no right-hand label', () => {
    const leader = declarations(sheets['../styles/seam-form.css'] ?? '', '.premise-leader');
    expect(leader).toContain('border-top: 1px dotted var(--rule)');
    expect(sheets['../styles/seam-form.css'] ?? '').not.toMatch(/\.premise-field\s*\{[^}]*text-align:\s*right/u);
  });
});
