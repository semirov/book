import { describe, expect, it } from 'vitest';

import { firstDeclarations, hasRule, mediaBlockList, rules, unionDeclarations } from './cssRules.ts';

/**
 * BOOK-128 comment #3852 — the accordion's geometry, read as text.
 *
 * jsdom has no layout, so the claims a browser would make with pixels are made here against the
 * declarations that make them true — and, just as important, against the rules that must **not**
 * exist any more. The three deleted rules are the floating layer: the fixed card with its own
 * 62 dvh scroll, the absolutely positioned reader block waiting for the margin pass, and the
 * zero-height seat that existed to give it a coordinate space. A sheet that quietly grows one
 * of them back would put a surface over the prose again.
 *
 * The height timeline itself is not claimed here: `scripts/accordion-cdp.mjs` measures it in
 * Chromium, because a transition is a browser's fact.
 */

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });
const record = sheets['../styles/record.css'] ?? '';
const panels = sheets['../styles/panels.css'] ?? '';
const reader = sheets['../styles/reader.css'] ?? '';

describe('the block is a block, never a layer', () => {
  it('has no position, no shadow, no overflow and no max-height', () => {
    const base = firstDeclarations(record, '.rec');
    expect(base, 'the block is styled').not.toBe('');
    expect(base).not.toMatch(/position\s*:/u);
    expect(base).not.toContain('box-shadow');
    // `overflow-anchor: none` is the anchoring contract, not a scrollbar: no `overflow` property
    // may be stated, and the anchor opt-out is the one `overflow-*` allowed.
    expect(base).not.toMatch(/overflow\s*:/u);
    expect(base).toContain('overflow-anchor: none');
    expect(base).not.toContain('max-height');
    expect(base).not.toContain('z-index');
  });

  it('never caps its own height in any declaration of the sheet', () => {
    // `max-height` on the block or its body would be the scrollbar the design forbids; the
    // form's textarea is the one scroller and it lives in the form's own sheet.
    const declarations = rules(record).map(([, body]) => body).join('\n');
    expect(declarations).not.toMatch(/max-height/u);
    expect(declarations).not.toMatch(/overflow:\s*(auto|scroll)/u);
  });

  it('is full column with the three hairlines and the 12/16/12 padding', () => {
    const sheet = firstDeclarations(record, '.rec-sheet');
    expect(sheet).toContain('border-top: 1px solid var(--rule-2)');
    expect(sheet).toContain('border-left: 1px solid var(--rule-2)');
    expect(sheet).toContain('border-bottom: 1px solid var(--rule)');
    expect(sheet).toContain('padding: 12px 0 12px 16px');
    // The paragraph gap is a clip-height spacer, never a margin: a margin escapes the 0fr track
    // and moves the next paragraph before the block has opened.
    expect(firstDeclarations(record, '.rec-gap')).toContain('height: 10px');
    // The paragraph's own air is taken back, so mounting the block moves nothing.
    expect(firstDeclarations(record, '.p + .rec')).toContain('margin-top: -1.02em');
    expect(sheet).toContain('margin: 0');
    // No right rule: the ✕ stands on the prose's own right edge.
    expect(sheet).not.toContain('border-right');
  });
});

describe('the disclosure', () => {
  it('mounts at 0fr and opens to 1fr: 220 ms out, 150 ms in, no bounce', () => {
    const closed = rules(record).find(([selector]) => selector === '.rec-clip')?.[1] ?? '';
    expect(closed).toContain('grid-template-rows: 0fr');
    expect(closed).toContain('transition: grid-template-rows 150ms var(--ease-in)');
    const open = rules(record).find(([selector]) => selector === ".rec[data-acc='open'] .rec-clip")?.[1] ?? '';
    expect(open).toContain('grid-template-rows: 1fr');
    expect(open).toContain('transition: grid-template-rows 220ms var(--ease-out)');
    expect(open).not.toContain('cubic-bezier(0.34');
    // The clip's child is the only element allowed to hide what the track does not have yet.
    const inner = firstDeclarations(record, '.rec-inner');
    expect(inner).toContain('min-height: 0');
    expect(inner).toContain('overflow: hidden');
  });

  it('turns the motion off under prefers-reduced-motion', () => {
    const reduced = mediaBlocksOf('prefers-reduced-motion: reduce');
    expect(reduced).toContain('transition: none');
  });
});

describe('the touch mark', () => {
  it('is text decoration: solid live open, dotted quiet closed, offset 3 px', () => {
    const base = firstDeclarations(record, '.p [data-touch]');
    expect(base).toContain('text-decoration: underline 1px var(--live)');
    expect(base).toContain('text-underline-offset: 3px');
    expect(base).not.toContain('background');
    expect(base).not.toContain('position');
    // Closed after a touch (and on the frozen frame): the same line, dotted and quiet.
    const last = rules(record).find(([selector]) => selector.includes("[data-mark='last']"))?.[1] ?? '';
    expect(last).toContain('text-decoration-style: dotted');
    expect(last).toContain('text-decoration-color: var(--ink-3)');
    const frozen = rules(record).find(([selector]) => selector.includes("[data-mark='frozen']"))?.[1] ?? '';
    expect(frozen).toContain('dotted');
  });
});

describe('the deleted floating layer', () => {
  it('has no fixed filing card, no 62 dvh scroll and no fade', () => {
    const card = firstDeclarations(panels, '.filing-panel');
    expect(card, 'the card is still styled').not.toBe('');
    expect(card).not.toContain('position: fixed');
    expect(card).not.toMatch(/max-height:\s*62dvh/u);
    expect(card).toContain('max-height: none');
    expect(card).not.toContain('overflow: auto');
    expect(card).not.toMatch(/animation:\s*seam-fade/u);
    expect(card).toContain('animation: none');
    const declarations = rules(panels).map(([, body]) => body).join('\n');
    expect(declarations).not.toContain('62dvh');
    expect(panels).not.toContain('@keyframes seam-fade');
  });

  it('has no absolutely positioned reader block and no zero-height seat', () => {
    const block = unionDeclarations(reader, '.prov-block');
    expect(block, 'the reader block is still styled').not.toBe('');
    expect(block).not.toContain('position: absolute');
    expect(block).not.toContain('var(--note-fit)');
    expect(hasRule(reader, '.sentence-seat')).toBe(false);
    const sentence = firstDeclarations(reader, '.sentence-block');
    expect(sentence).not.toContain('position: absolute');
    expect(sentence).not.toContain('opacity: 0');
  });
});

/** Every `@media (prefers-reduced-motion: reduce)` block of the accordion's sheet, as text. */
function mediaBlocksOf(query: string): string {
  return mediaBlockList(record)
    .filter((block) => block.query === query)
    .map((block) => block.body)
    .join('\n');
}
