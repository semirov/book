import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-33 — the seam's own CSS, asserted where files can be read.
 *
 * Two things a jsdom test cannot prove: the mark's hit area (jsdom has no layout) and the
 * absence of the deleted composer's rules (a stylesheet is not a component). Both are plain
 * text here, so the guard is exact.
 */

const ROOT = join(import.meta.dirname, '../..');
const seamForm = readFileSync(join(ROOT, 'web/src/styles/seam-form.css'), 'utf8');
const seam = readFileSync(join(ROOT, 'web/src/styles/seam.css'), 'utf8');
const book = readFileSync(join(ROOT, 'web/src/styles/book.css'), 'utf8');

describe('the mark’s target is 24×24 and off the prose (major 5)', () => {
  it('keeps the numeral inline and puts the 24×24 box in the paragraph’s margin', () => {
    const rule = /\.filing-mark \{[^}]+\}/u.exec(seamForm)?.[0] ?? '';
    expect(rule).toContain('width: 24px');
    expect(rule).toContain('height: 24px');
    expect(rule).toContain('position: absolute');
    // The box sits in the right margin on the mark's line, so it covers no character.
    expect(rule).toContain('right: -24px');
    expect(rule).toContain('display: flex');
    // The button is visible: the numeral inside it is the mark a reader sees.
    expect(rule).not.toContain('opacity: 0');
    const numeral = /\.filing-mark-num \{[^}]+\}/u.exec(seamForm)?.[0] ?? '';
    expect(numeral).toContain('font-family: var(--mono)');
    expect(numeral).toContain('border: 1px solid currentColor');
  });
});

describe('the deleted composer left no rules behind (major 11)', () => {
  it('has no .composer rule in any stylesheet', () => {
    for (const [name, css] of [
      ['book.css', book],
      ['seam.css', seam],
      ['seam-form.css', seamForm],
    ] as const) {
      expect(css, name).not.toMatch(/\.composer/u);
    }
  });
});
