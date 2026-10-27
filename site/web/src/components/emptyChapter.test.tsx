import type { CatalogEntry } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-90 A — the empty chapter is one row, once.
 *
 * One numeral, one word, one dotted field; no `ch-h`, no big `ch-n`, no meta line. The one
 * explanation sentence is the page's and is printed under the first empty chapter only, from
 * the `firstEmpty` data the renderer passes — never a global flag, never a timer.
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

describe('one row, one numeral, one hint', () => {
  it('renders no heading and exactly one numeral per empty chapter', () => {
    const html = [article(entry(3), true), article(entry(4)), article(entry(5))].join('\n');
    expect(count(html, 'class="premise-n"')).toBe(3);
    expect(count(html, 'class="ch-n"')).toBe(0);
    expect(html).not.toContain('class="ch-h"');
    expect(html).not.toContain('ch-meta');
    expect(html).not.toContain('не написана');
  });

  it('prints the explanation sentence exactly once, under the first empty chapter', () => {
    const html = [article(entry(3), true), article(entry(4)), article(entry(5))].join('\n');
    expect(count(html, 'class="premise-hint"')).toBe(1);
    // It is under chapter 3: the first hint follows the first row and precedes chapter 4.
    const firstHint = html.indexOf('class="premise-hint"');
    expect(html.slice(0, firstHint)).toContain('глава 3');
    expect(html.slice(firstHint)).not.toContain('глава 3');
  });

  it('wires the hint as data: another first empty chapter moves it, nothing else changes', () => {
    const html = [article(entry(3)), article(entry(4), true), article(entry(5))].join('\n');
    expect(count(html, 'class="premise-hint"')).toBe(1);
    const firstHint = html.indexOf('class="premise-hint"');
    expect(html.slice(0, firstHint)).toContain('глава 4');
    expect(html.slice(firstHint)).not.toContain('глава 4');
  });

  it('orders the row numeral → word → leader, and the leader is the field', () => {
    const html = article(entry(7), true);
    const numeral = html.indexOf('class="premise-n"');
    const word = html.indexOf('class="premise-label"');
    const leader = html.indexOf('class="premise-field premise-leader"');
    expect(numeral).toBeGreaterThan(-1);
    expect(word).toBeGreaterThan(numeral);
    expect(leader).toBeGreaterThan(word);
    expect(html).toContain('aria-label="глава 7 · замысел"');
  });

  it('gives the word slot to a real title, and keeps the quote for a held premise', () => {
    const titled = article(entry(7, { title: 'Перевод смены' }));
    expect(titled).toContain('class="premise-label">Перевод смены<');
    expect(titled).not.toContain('замысел');
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
    expect(row).toContain('grid-template-columns: auto auto minmax(0, 1fr)');
    expect(row).toContain('min-height: 44px');
    // The hint is the same inset: it wraps on the prose's right edge and never sizes the box.
    const hint = declarations(sheets['../styles/seam-form.css'] ?? '', '.premise-hint');
    expect(hint).not.toContain('max-width');
    expect(hint).toContain('padding-inline-end: max(0px, calc(100% - var(--measure)))');
    // The numeral is the mono micro rung, tabular, and the word is the label register at 12.
    expect(declarations(sheets['../styles/seam-form.css'] ?? '', '.premise-n')).toContain('font-variant-numeric: tabular-nums');
    const label = declarations(sheets['../styles/seam-form.css'] ?? '', '.premise-label');
    expect(label).toContain('font-family: var(--label)');
    expect(label).toContain('font-size: var(--fs-micro)');
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
