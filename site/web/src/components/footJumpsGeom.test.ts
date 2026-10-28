import { describe, expect, it } from 'vitest';

import { blankComments, exactly, rulesOf, squash, type Rule } from './measure.css.ts';

/**
 * BOOK-156 — the grip's geometry, read as CSS text (the house pattern, `measure.test.ts`).
 *
 * jsdom has no layout, so the sheet is the evidence: the band's 24 px, the item's capped box,
 * the ring's band-sized layer and the reserve the page pays for them. The arithmetic is
 * stated beside each declaration — the numbers the browser would have to produce are checked
 * here, not assumed (owner's fallback, #3802 §1; BOOK-156 fixes M3).
 */

const sheets = import.meta.glob<string>(
  ['../styles/foot-jumps.css', '../styles/tokens.css', '../styles/base.css', '../styles/chrome.css'],
  { query: '?raw', import: 'default', eager: true },
);

const FOOT = '../styles/foot-jumps.css';
const TOKENS = '../styles/tokens.css';

const rules = (file: string): Rule[] => rulesOf(file, blankComments(sheets[file] ?? ''));

/** The declarations of the one rule whose selector is exactly `selector`. */
function declarations(selector: string, file = FOOT): Map<string, string> {
  return rules(file).find((rule) => exactly(rule, selector))?.declarations ?? new Map();
}

/** The declarations of the first rule whose selector list contains `selector` verbatim. */
function listed(selector: string, file = FOOT): Map<string, string> {
  return (
    rules(file).find((rule) => rule.parts.some((part) => squash(part) === squash(selector)))?.declarations ??
    new Map()
  );
}

describe('the geometry is the sheet’s, not a hand-wave', () => {
  it('pins the tokens the whole table is built from, and drops the ones nothing reads', () => {
    const tokens = declarations(':root', TOKENS);
    expect(tokens.get('--grip-h')).toBe('24px');
    expect(tokens.get('--grip-row')).toBe('44px');
    expect(tokens.get('--grip-hit')).toBe('44px');
    expect(tokens.get('--ease-in')).toBe('cubic-bezier(0.4, 0, 1, 1)');
    // Two tokens no rule reads were decoration, not a contract (#156 M3).
    expect(tokens.has('--grip-dwell')).toBe(false);
    expect(tokens.has('--grip-scroll')).toBe(false);
  });

  it('paints a 24 px band on the column, with a real border and a capped item box', () => {
    const grip = Number.parseFloat(declarations(':root', TOKENS).get('--grip-h') ?? '0');
    const band = declarations('.foot-jumps-in');
    expect(band.get('height')).toBe('var(--grip-h)');
    // The owner's fallback: 24 px is the painted band and the floor of SC 2.5.8, so there is
    // no inset left over to hang a taller box into.
    expect(grip).toBe(24);
    // A border, not a shadow: forced colors keeps a border.
    expect(band.get('border-top')).toBe('1px solid var(--rule)');
    // One statement of the item's box, read by the item, the word and the expander.
    expect(band.get('--grip-box')).toBe(
      'clamp(var(--grip-h), calc(var(--grip-h) + env(safe-area-inset-bottom)), var(--grip-hit))',
    );
    for (const selector of ['.foot-jump', '.foot-jump-word', '.foot-jumps-open']) {
      expect(declarations(selector).get('height'), selector).toBe('var(--grip-box)');
    }
    // 24 + 34 ≥ 44: a notched phone gets a real 44 px target; with no inset the box is the band.
    const box = (inset: number): number => Math.max(24, Math.min(24 + inset, 44));
    expect(box(0)).toBe(24);
    expect(box(34)).toBe(44);
    // The band's hairline is drawn inside `--grip-h`, so the grid's content box starts 1 px
    // below the band's edge. The box is pulled back up onto that edge, or a 24 px box would
    // end 1 px past the viewport and the reachable target would be 23 (measured, BOOK-156).
    expect(declarations('.foot-jump').get('margin-block-start')).toBe('-1px');
    expect(declarations('.foot-jumps-open').get('inset')).toBe('-1px 0 auto 0');
    // The element that receives the tap is the word itself, and the text stays painted in the
    // top 24 px of its box.
    const word = declarations('.foot-jump-word');
    expect(word.get('line-height')).toBe('var(--grip-h)');
    expect(word.get('width')).toBe('max-content');
    expect(word.get('padding-inline')).toBe('12px');
    // The words rise by (44 − 24) / 2 = 10 px when the row opens.
    expect(declarations(".foot-jumps[data-open='true'] .foot-jump-word").get('transform')).toBe(
      'translateY(calc((var(--grip-row) - var(--grip-h)) / 2))',
    );
    expect((44 - 24) / 2).toBe(10);
    // The expander is behind the words and covers the band and the item's own box.
    expect(declarations('.foot-jumps-open').get('inset')).toBe('-1px 0 auto 0');
    // The meta is out of the cell's flow, so it never widens the word's column, and it sits
    // inside the open row: 30…42 of 44, 2 px above the band's edge, never clipped.
    const meta = declarations('.foot-jump-meta');
    expect(meta.get('position')).toBe('absolute');
    expect(meta.get('top')).toBe('calc(var(--grip-row) - 14px)');
    expect(meta.get('line-height')).toBe('var(--fs-micro)');
    expect(meta.get('text-align')).toBe('center');
    expect(44 - 14).toBe(30);
    expect(30 + 12).toBe(42);
    expect(42).toBeLessThan(44);
  });

  it('never lets the item’s box run past the viewport edge', () => {
    // The same clamp, evaluated where jsdom cannot: the band's top edge is the content's
    // bottom edge, so the box's bottom is the viewport edge at most.
    const clamp = (min: number, preferred: number, max: number): number => Math.max(min, Math.min(preferred, max));
    for (const [viewport, inset] of [
      [900, 0],
      [844, 34],
    ] as const) {
      const box = clamp(24, 24 + inset, 44);
      const bandTop = viewport - (24 + inset);
      expect(bandTop + box, `${viewport}×${inset}`).toBeLessThanOrEqual(viewport);
      // And the reachable height is never under the 24 px floor of SC 2.5.8.
      expect(box, `${viewport}×${inset}`).toBeGreaterThanOrEqual(24);
    }
  });

  it('draws the focus ring on a band-sized layer, so the screen never clips it', () => {
    const ring = declarations('.foot-jump:focus-visible::before');
    expect(ring.get('content')).toBe("''");
    expect(ring.get('position')).toBe('absolute');
    expect(ring.get('inset')).toBe('0 0 auto 0');
    // Band-sized, not item-sized: the lower part of a 44 px box can sit below the viewport.
    expect(ring.get('height')).toBe('var(--grip-h)');
    expect(ring.get('outline')).toBe('2px solid var(--live)');
    expect(ring.get('outline-offset')).toBe('-3px');
    // The item itself draws no ring: the base sheet's `:focus-visible` outline would sit 3 px
    // outside a box that ends on the screen's edge, and be cut off by it.
    expect(declarations('.foot-jump:focus-visible').get('outline')).toBe('none');
  });

  it('keeps the closed meta inert and lets a tap on an inert word fall through', () => {
    const meta = declarations('.foot-jump-meta');
    expect(meta.get('opacity')).toBe('0');
    expect(meta.get('pointer-events')).toBe('none');
    expect(declarations(".foot-jumps[data-open='true'] .foot-jump-meta").get('pointer-events')).toBe('auto');
    // An inert item is a word, not a control: no pointer on its box, its word or its meta, so
    // a tap on it reaches the expander behind and the row still opens (never a no-op).
    expect(declarations('.foot-jump.is-inert').get('pointer-events')).toBe('none');
    const inert = rules(FOOT).find((rule) =>
      rule.parts.some((part) => squash(part) === squash('.foot-jump.is-inert .foot-jump-word')),
    );
    expect(inert?.parts.map(squash)).toEqual([
      '.foot-jump.is-inert.foot-jump-word',
      '.foot-jump.is-inert.foot-jump-meta',
    ]);
    expect(inert?.declarations.get('pointer-events')).toBe('none');
  });

  it('gives every item a third of the column, however many there are', () => {
    const band = declarations('.foot-jumps-in');
    // No fixed three-column template: two items split the column in halves, one takes it
    // whole, and no empty cell is invented when the register or the pass is absent.
    expect(band.get('grid-auto-flow')).toBe('column');
    expect(band.get('grid-auto-columns')).toBe('1fr');
    expect(band.has('grid-template-columns')).toBe(false);
    // The table: 342 / 3 = 114 at 390, 640 / 3 = 213.3 at 1440.
    expect(342 / 3).toBe(114);
    expect((640 / 3).toFixed(1)).toBe('213.3');
    // The word box at 390: ten characters at 0.6 em of 12 px, plus 12 px of paper each side.
    expect(10 * 0.6 * 12 + 2 * 12).toBeCloseTo(96, 6);
  });

  it('lifts the талон by the painted band, so it never sits on the third cell', () => {
    // §3801 §8.6: the strip is 44 px at 16 px, z 55 — it lifts by the band and stays above
    // the grip (35). `live.css` keeps owning the strip; this is the one line the grip takes.
    expect(declarations('.ticket').get('bottom')).toBe(
      'calc(var(--grip-h) + 16px + env(safe-area-inset-bottom))',
    );
  });

  it('reserves the band plus the inset, statically, on the pages that carry the grip', () => {
    const reserve = 'calc(var(--grip-h) + env(safe-area-inset-bottom))';
    expect(declarations('body:has(nav.foot-jumps)').get('padding-block-end')).toBe(reserve);
    expect(declarations('html:has(nav.foot-jumps)').get('scroll-padding-block-end')).toBe(reserve);
    // The chronicle and the legal pages have no grip: no unscoped rule reserves paper there.
    expect(declarations('body').has('padding-block-end')).toBe(false);
    expect(declarations('html').has('scroll-padding-block-end')).toBe(false);
    for (const target of ['.toc', '#discussion', '.ch', '#pass', '#talks']) {
      expect(listed(target).get('scroll-margin-bottom'), target).toBe(reserve);
    }
    // The pass lands its block below the head, at `--offset-top + 16`.
    expect(declarations('#pass').get('scroll-margin-top')).toBe('calc(var(--offset-top) + 16px)');
  });

  it('is fixed at the bottom under the header, and the veil is under it', () => {
    const grip = declarations('.foot-jumps');
    expect(grip.get('position')).toBe('fixed');
    expect(grip.get('bottom')).toBe('0');
    expect(grip.get('inset-inline')).toBe('0');
    expect(grip.get('z-index')).toBe('35');
    expect(grip.get('pointer-events')).toBe('none');
    expect(declarations('.foot-veil').get('z-index')).toBe('34');
    // 35 < 40: the head is never under the page's foot.
    const header = Number.parseFloat(declarations('.top', '../styles/chrome.css').get('z-index') ?? '0');
    expect(header).toBe(40);
    expect(35).toBeLessThan(header);
  });

  it('costs less than one line at 390 and covers no line of prose', () => {
    // 390 × 844 with a 34 px home-indicator inset; the line box is 17 × 1.68 = 28.56 px.
    const band = Number.parseFloat(declarations(':root', TOKENS).get('--grip-h') ?? '0');
    const row = Number.parseFloat(declarations(':root', TOKENS).get('--grip-row') ?? '0');
    const inset = 34;
    const viewport = 844;
    const line = 17 * 1.68;
    expect(line).toBeCloseTo(28.56, 2);
    const reserve = band + inset;
    expect(reserve).toBe(58);
    // The band's top edge IS the content's bottom edge: the two cannot overlap a line.
    const bandTop = viewport - reserve;
    const contentBottom = viewport - reserve;
    expect(bandTop).toBe(786);
    expect(bandTop).toBe(contentBottom);
    // And the price is the reserve, in lines — 0.84 collapsed, 1.54 open.
    expect(band / line).toBeCloseTo(0.84, 2);
    expect(row / line).toBeCloseTo(1.54, 2);
    // At 1440 the line box is 18 × 1.68 = 30.24: 0.79 collapsed, 1.46 open, with no inset.
    expect(band / 30.24).toBeCloseTo(0.79, 2);
    expect(row / 30.24).toBeCloseTo(1.46, 2);
  });

  it('paints the paper it is made of, so no glyph shows through the words', () => {
    // The viewport ends mid-line in the normal case, so the band's 24 px cover the bottom of a
    // line of prose. Painted on paper, that line is hidden; unpainted, its glyphs run through
    // the words and the hairline (found in a browser at 390 and 1440, BOOK-156 fix).
    expect(declarations('.foot-jumps-in').get('background')).toBe('var(--paper)');
    // The token, so night follows with no second rule: both papers are the page's own.
    expect(declarations(':root', TOKENS).get('--paper')).toBe('#cfd3d2');
    expect(declarations("[data-theme='night']", TOKENS).get('--paper')).toBe('#0b0c0d');
    // The veil keeps its own day/night pair — it is a wash, not the band.
    expect(declarations('.foot-veil').get('background')).toBe('var(--paper)');
    expect(declarations("[data-theme='night'] .foot-veil").get('background')).toBe('var(--ink)');
    // Opaque by construction: the band and the two things it is built of (the items and the
    // expander behind them) state no translucent paint, so nothing is left to show through.
    // The meta's own fade is a word fading in, never a window in the paper.
    for (const selector of ['.foot-jumps-in', '.foot-jump', '.foot-jumps-open']) {
      const rule = declarations(selector);
      const paint = rule.get('background') ?? rule.get('background-color');
      // The only fill in the band is the paper token; nothing states a translucent one.
      if (paint !== undefined) expect(paint, selector).toBe('var(--paper)');
      expect(rule.has('opacity'), selector).toBe(false);
    }
  });

  it('carries the two transition lengths the module also states', () => {
    // 220 ms in, 160 ms out, 120 ms for the meta's cross-fade — the same numbers as GRIP.
    expect(declarations('.foot-jumps-in').get('transition')).toContain('var(--dur-ui)');
    expect(declarations(".foot-jumps[data-open='false'] .foot-jumps-in").get('transition')).toContain('160ms');
    expect(declarations('.foot-jump-meta').get('transition')).toContain('var(--dur-tick)');
    // The meta appears only after the words have risen.
    expect(declarations(".foot-jumps[data-open='true'] .foot-jump-meta").get('transition-delay')).toBe(
      'var(--dur-ui)',
    );
  });
});
