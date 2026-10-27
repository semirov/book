import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-33 / BOOK-90 — the mark's own CSS, asserted where files can be read.
 *
 * Two things a jsdom test cannot prove: the mark's hit area (jsdom has no layout) and the
 * absence of the deleted composer's rules (a stylesheet is not a component). Both are plain
 * text here, so the guard is exact.
 *
 * BOOK-90 moved the mark out of `seam-form.css` into `marginalia.css`: the numeral is no
 * longer a 24 px box in the phone gutter, but a 40 × 44 target at the prose's right edge
 * (24 × 44 below 1024, where the numeral leaves the text for the strip).
 */

const ROOT = join(import.meta.dirname, '../..');
const seamForm = readFileSync(join(ROOT, 'web/src/styles/seam-form.css'), 'utf8');
const seam = readFileSync(join(ROOT, 'web/src/styles/seam.css'), 'utf8');
const book = readFileSync(join(ROOT, 'web/src/styles/book.css'), 'utf8');
const marginalia = readFileSync(join(ROOT, 'web/src/styles/marginalia.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css);
  return match?.[1] ?? '';
}

describe('the mark’s target is 40×44 at ≥1024 and 24×44 below (BOOK-90)', () => {
  it('starts exactly at the prose’s right edge, in one box for both marks', () => {
    const mark = rule(marginalia, '.filing-mark');
    expect(mark).toContain('left: 100%');
    expect(mark).toContain('width: var(--mark-hit)');
    expect(mark).toContain('height: 44px');
    expect(mark).toContain('position: absolute');
    expect(mark).toContain('display: flex');
    expect(mark).toContain('padding: 0 0 0 4px');
    // The button is visible: the numeral inside it is the mark a reader sees.
    expect(mark).not.toContain('opacity: 0');
    // The accepted mark is the 1 × 16 hairline, not a second box.
    const tick = rule(marginalia, '.filing-tick-bar');
    expect(tick).toContain('width: 1px');
    expect(tick).toContain('height: 16px');
    const numeral = rule(marginalia, '.filing-mark-num');
    expect(numeral).toContain('font-family: var(--mono)');
    expect(numeral).toContain('font-size: var(--fs-micro)');
  });

  it('drops the numeral and keeps a 24 px target below 1024', () => {
    const narrow = marginalia.slice(marginalia.indexOf('@media (max-width: 1023px)'));
    expect(narrow).toContain('.filing-mark {');
    expect(rule(narrow, '.filing-mark')).toContain('width: 24px');
    expect(rule(narrow, '.filing-mark-num')).toContain('display: none');
    // No second, subtler breakpoint for the mark (the old 599 px `right: -22px` is gone).
    expect(marginalia).not.toMatch(/@media \(max-width: 599px\)/u);
    expect(marginalia).not.toContain('right: -22px');
  });

  it('never uses --rule-2 as a text ink: the stopped state is --ink-2 and struck', () => {
    expect(rule(marginalia, '.filing-mark.ink-stopped')).toContain('color: var(--ink-2)');
    expect(rule(marginalia, '.filing-mark.ink-stopped .filing-mark-num')).toContain('line-through');
    expect(rule(seamForm, '.ink-stopped')).toContain('color: var(--ink-2)');
    expect(rule(seamForm, '.ink-stopped')).not.toContain('--rule-2');
  });
});

describe('the deleted composer left no rules behind (major 11)', () => {
  it('has no .composer rule in any stylesheet', () => {
    for (const [name, css] of [
      ['book.css', book],
      ['seam.css', seam],
      ['seam-form.css', seamForm],
      ['marginalia.css', marginalia],
    ] as const) {
      expect(css, name).not.toMatch(/\.composer/u);
    }
  });
});
