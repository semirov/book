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
 *
 * BOOK-128 #3900 §1 — the strip's own shape is asserted here too: every `.seam-row` stacks (the
 * quote on its own line, the acts under it in the mark face), and the collapsed `.seam-prov-line`
 * stays one line in one face (BOOK-111). A stylesheet is text, so the shape is read, not drawn.
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
  it('stands 16 px after the prose’s right edge, in one box for both marks', () => {
    const mark = rule(marginalia, '.filing-mark');
    // BOOK-208: the air at the measure is its own token; the target stands after it. The
    // fallbacks keep a page without the token block from resolving `left` to `auto`.
    expect(mark).toContain('left: calc(100% + var(--mark-air, 16px))');
    expect(mark).toContain('width: var(--mark-hit, 40px)');
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

describe('the strip is two lines at every width: the quote, then the acts (BOOK-128 #3900 §1)', () => {
  /* #3900 §1 — one line carries one face and one size. The word (serif italic 15) takes the
     full width on its own line; the door, the draft, the action and the ✕ stand under it in the
     mark face (mono 12). `flex-wrap: wrap` on the base row is the whole mechanism, and every act
     keeps its own 44 px target, so the second line is still a touch row.

     The frozen strip has no stack of its own any more: its longer acts simply wrap onto a second
     marks line, which is the owner's own rule («better several lines than glued together with a
     line break»). The phone block only narrows what is a target there. */
  const narrow = seam.slice(seam.indexOf('@media (max-width: 767px)'));
  const row = rule(seam, '.seam-row');
  const word = rule(seam, '.seam-word');

  it('stacks the base row: the quote on its own line, the acts under it', () => {
    expect(row).toContain('flex-wrap: wrap');
    expect(row).toContain('min-height: 44px');
    // The quote takes the whole first line and is printed whole: it wraps inside its own line
    // rather than growing an ellipsis.
    expect(word).toContain('flex: 1 1 100%');
    expect(word).toContain('font-family: var(--serif)');
    expect(word).toContain('font-style: italic');
    expect(word).toContain('font-size: var(--fs-note)');
    expect(word).not.toContain('text-overflow');
    expect(word).not.toContain('white-space: nowrap');
  });

  it('keeps every act in the mark register, each a 44 px target', () => {
    for (const selector of ['.seam-prov', '.seam-cta', '.seam-close']) {
      expect(rule(seam, selector), selector).toContain('font-family: var(--mono)');
      expect(rule(seam, selector), selector).toContain('font-size: var(--fs-micro)');
    }
    expect(rule(seam, '.seam-prov')).toContain('min-height: 44px');
    expect(rule(seam, '.seam-cta')).toContain('min-height: 44px');
    // The strip's one close keeps the touch target it always had.
    expect(rule(seam, '.seam-close')).toContain('width: 44px');
    expect(rule(seam, '.seam-close')).toContain('height: 44px');
  });

  it('has no frozen-only stack: the phone block narrows targets and touches no row', () => {
    expect(narrow).not.toBe('');
    expect(narrow).toContain('@media (max-width: 767px)');
    // The frozen re-ordering is gone: the base stack is the one shape, at every width.
    expect(narrow).not.toContain("[data-frozen='true']");
    expect(rule(narrow, '.seam-row')).toBe('');
    // A premise's state word is not a control: it is one line, not a 44 px target.
    expect(rule(narrow, 'span.seam-prov')).toContain('min-height: 0');
    // Every tappable line is a 44 px target, and the filing's facts wrap instead of clipping.
    expect(rule(narrow, '.seam-filing')).toContain('min-height: 44px');
    expect(rule(narrow, '.seam-filing-line')).toContain('flex-wrap: wrap');
    const quote = rule(narrow, '.seam-filing-quote');
    expect(quote).toContain('overflow: visible');
    expect(quote).toContain('-webkit-line-clamp: unset');
    // An action label is a word, never a wrapped phrase.
    expect(rule(narrow, '.seam-inline-action')).toContain('white-space: nowrap');
  });

  it('keeps the collapsed line one line, one face (BOOK-111)', () => {
    // `.seam-prov-line` is the strip while a panel speaks for it: one row, and it never stacks
    // on a phone. (Its word keeps BOOK-111's own ellipsis for a phrase that truly cannot fit;
    // what this test holds is that the line stays one line in one face.)
    const line = rule(seam, '.seam-prov-line');
    expect(line).toContain('display: flex');
    expect(line).toContain('min-height: 44px');
    expect(line).toContain('white-space: nowrap');
    expect(line).not.toContain('flex-wrap: wrap');
    expect(rule(seam, '.seam-prov-word')).toContain('font-family: var(--mono)');
    expect(rule(seam, '.seam-prov-word')).toContain('font-size: var(--fs-micro)');
    expect(rule(seam, '.seam-prov-trail')).toContain('font-family: var(--mono)');
    expect(rule(seam, '.seam-prov-trail')).toContain('font-size: var(--fs-micro)');
  });
});
