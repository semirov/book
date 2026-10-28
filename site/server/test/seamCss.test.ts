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

describe('the tap target at 390 is the word, not an overlay (BOOK-137)', () => {
  it('hides the desktop rail below 1024 rather than floating it over the prose', () => {
    const narrow = seamForm.slice(seamForm.indexOf('@media (max-width: 1023px)'));
    expect(narrow).not.toBe('');
    expect(rule(narrow, '.seam-rail')).toContain('display: none');
    // Above that it lives in the 198 px outer margin, and only while the paragraph is hovered.
    const rail = rule(seamForm, '.seam-rail');
    expect(rail).toContain('left: -104px');
    expect(rail).toContain('opacity: 0');
    expect(rule(seamForm, '.seam-rail')).not.toContain('right: 0');
  });

  it('keeps the frame row in the flow: no absolutely-positioned overlay over .p', () => {
    // The strip is a block sibling after the paragraph (BOOK-68). Nothing the frame adds — the
    // label, the link, the warning — may become a layer the reader taps instead of the word.
    for (const selector of ['.seam', '.seam-row', '.seam-prov', '.seam-frame', '.seam-frozen', '.seam-word']) {
      const declarations = rule(seam, selector);
      expect(declarations, selector).not.toContain('position: absolute');
      expect(declarations, selector).not.toContain('position: fixed');
    }
    expect(seam).not.toMatch(/\.seam(?:-(?:row|frame|frozen|word))?\s*\{[^}]*position:\s*(?:absolute|fixed)/u);
    // The paragraph is the positioning context (the rail's own anchor), and it is a block.
    expect(rule(seam, '.p')).toContain('position: relative');
    expect(seam).toMatch(/\.seam\s*\{[^}]*border-top: 1px solid/u);
  });

  it('prints the frame warning in the note register, one line', () => {
    expect(rule(seam, '.seam-frame')).toContain('color: var(--ink-2)');
    // No box, no rule of its own: the strip already carries them.
    expect(rule(seam, '.seam-frame')).not.toContain('border');
    expect(rule(seam, '.seam-frame')).not.toContain('position');
  });
});

describe('below 768 the strip is one 44 px row, and the frozen strip is the one stack', () => {
  /* BOOK-128 comment #3815 — the word's record is the strip's own body now, so the row must stay
     one row at the phone: the reader tapped it, the body grows *under* it, and a row that
     re-flowed when the facts opened would move the page under their thumb. The word ellipsises
     instead. The frozen strip keeps BOOK-90's stack — its door («рамка книги · не меняется») and
     its link («рамка книги →») are two long phrases that cannot share 366 px with the action and
     the ✕, and the owner's rule stands: «better several lines than glued together». */
  const narrow = seam.slice(seam.indexOf('@media (max-width: 767px)'));

  it('targets the phone range and keeps the ordinary row on one line', () => {
    expect(narrow).not.toBe('');
    expect(narrow).toContain('@media (max-width: 767px)');
    expect(rule(narrow, '.seam-row')).toContain('flex-wrap: nowrap');
    expect(rule(seam, '.seam-row')).toContain('min-height: 44px');
  });

  it('stacks only the frozen strip, where two long phrases cannot share the row', () => {
    expect(narrow).toContain(".seam[data-frozen='true'] .seam-row {");
    const frozen = narrow.slice(narrow.indexOf(".seam[data-frozen='true'] .seam-row {"));
    expect(frozen).toContain('flex-wrap: wrap');
    const prov = rule(frozen, ".seam[data-frozen='true'] .seam-prov");
    expect(prov).toContain('order: 1');
    expect(prov).toContain('flex: 0 0 100%');
    const word = rule(frozen, ".seam[data-frozen='true'] .seam-word");
    expect(word).toContain('order: 2');
    expect(word).toContain('flex: 0 0 100%');
    // The quote is whole: no clamp, no ellipsis, no forced single line where it stacks.
    expect(word).toContain('white-space: normal');
    expect(word).toContain('text-overflow: clip');
    expect(word).not.toContain('ellipsis');
    const close = rule(frozen, ".seam[data-frozen='true'] .seam-close");
    expect(close).toContain('order: 5');
    expect(close).toContain('margin-left: auto');
    // A premise's state word is not a control.
    expect(rule(narrow, 'span.seam-prov')).toContain('min-height: 0');
  });

  it('keeps every action label on one line, and never clips a filing quote', () => {
    expect(narrow).toMatch(/white-space: nowrap/u);
    expect(rule(narrow, '.seam-filing')).toContain('min-height: 44px');
    expect(rule(narrow, '.seam-filing-line')).toContain('flex-wrap: wrap');
    const quote = rule(narrow, '.seam-filing-quote');
    expect(quote).toContain('overflow: visible');
    expect(quote).toContain('-webkit-line-clamp: unset');
  });

  it('leaves the one-row strip above 768 exactly as it was', () => {
    // The desktop row still truncates its quote rather than growing: the phone rule is a
    // separate block, not a change to the base.
    expect(rule(seam, '.seam-word')).toContain('text-overflow: ellipsis');
    expect(rule(seam, '.seam-word')).toContain('white-space: nowrap');
  });
});
