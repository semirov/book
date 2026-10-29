import { describe, expect, it } from 'vitest';

import { firstDeclarations, mediaBlocks } from './cssRules.ts';

/**
 * BOOK-208 — the margin's geometry, read as text.
 *
 * jsdom has no layout, so the claim the owner made with a browser is made here against the
 * declarations that make it true: 16 px of clear space at the measure, the mark's 40 px target
 * after it, the note after that. What this file is really about is the **fallback**: every
 * `left` and `width` of the channel carries its own value, because a page that lost the token
 * block used to compute `left: auto; width: auto` — the note then landed shrink-to-fit *inside*
 * the prose it annotates. A number here may move; a missing fallback may not.
 *
 * The pixels themselves are the pass's (`lib/marginPass.test.ts`) and the browser's
 * (`scripts/margin-cdp.mjs`): a rule stated here is not a measurement.
 */

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });
const tokens = sheets['../styles/tokens.css'] ?? '';
const marginalia = sheets['../styles/marginalia.css'] ?? '';

/** The `:root` block of `tokens.css` (the day palette's own declarations). */
function rootTokens(css: string): string {
  return firstDeclarations(css, ':root');
}

describe('the margin’s tokens (BOOK-208)', () => {
  it('states the air, the gap as air + target, and the note’s floor', () => {
    const root = rootTokens(tokens);
    expect(root).toContain('--mark-air: 16px');
    expect(root).toContain('--mark-hit: 40px');
    expect(root).toContain('--note-gap: calc(var(--mark-air) + var(--mark-hit))');
    expect(root).toContain('--note-min: 120px');
    expect(root).toContain('--note-w: 188px');
  });

  it('never lets the used width fall under the floor, and keeps the design’s cap', () => {
    const root = rootTokens(tokens);
    // 188 while the channel holds it, the channel itself from there down, 120 as the floor.
    expect(root).toContain(
      '--note-fit: min(var(--note-w), max(var(--note-min), calc((100vw - var(--measure)) / 2 - var(--note-gap) - 8px)))',
    );
  });
});

describe('the channel’s declarations carry their fallbacks (BOOK-208)', () => {
  it('places the mark after the air, and gives its target a fallback', () => {
    const mark = firstDeclarations(marginalia, '.filing-mark');
    expect(mark).toContain('left: calc(100% + var(--mark-air, 16px))');
    expect(mark).toContain('width: var(--mark-hit, 40px)');
  });

  it('places the note with a fallback for the left and for the width', () => {
    const rule = firstDeclarations(marginalia, '.margin-note');
    expect(rule, '.margin-note is styled').not.toBe('');
    expect(rule, '.margin-note states a left with a fallback').toContain(
      'left: calc(100% + var(--note-gap, 56px))',
    );
    // The width must never be able to resolve to `auto`: `--note-fit`, then the design's own
    // width, then nothing left to invent.
    expect(rule, '.margin-note states a width with a fallback').toContain(
      'width: var(--note-fit, var(--note-w, 188px))',
    );
    // The bare forms are what broke: a var() with no fallback is invalid when the token is gone.
    expect(rule).not.toMatch(/width:\s*var\(--note-fit\)\s*;/u);
    expect(rule).not.toMatch(/left:\s*calc\(100% \+ var\(--note-gap\)\)/u);
  });

  it('keeps the tick at the measure’s edge below 1024, still in the one breakpoint', () => {
    const narrow = mediaBlocks(marginalia, 'max-width: 1023px').join('\n');
    expect(narrow).toContain('.filing-mark');
    expect(firstDeclarations(narrow, '.filing-mark')).toContain('left: 100%');
    // One breakpoint: no `min-width` step was added to hold the desktop channel.
    expect(marginalia).not.toMatch(/@media[^{]*min-width/u);
  });
});
