import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * BOOK-90 AC5 — the marginalia's CSS contract, in the style-guard idiom.
 *
 * What a jsdom test cannot prove: that the mark is measured from the **prose's right edge**
 * (not from `--shell`/`--measure`/`--gut`), that the one breakpoint is 1023, and that the strip
 * cannot scroll sideways. The old channel **object** (the revision panel with its absolute
 * placement and the phone's fixed sheet) is gone; these claims now assert its absence, and the
 * record's own surfaces are checked to have no positioned layer at all. The column frame is the
 * other branch's: nothing here may read it.
 */

const STYLES = join(import.meta.dirname, '../../web/src/styles');
const marginalia = readFileSync(join(STYLES, 'marginalia.css'), 'utf8');
const tokens = readFileSync(join(STYLES, 'tokens.css'), 'utf8');
const base = readFileSync(join(STYLES, 'base.css'), 'utf8');
const book = readFileSync(join(STYLES, 'book.css'), 'utf8');
/** The sentences' own surfaces: the record, its notice and change sections, and the card. */
const reading = ['record.css', 'record-notice.css', 'record-change.css', 'panels.css'].map((name) =>
  withoutComments(readFileSync(join(STYLES, name), 'utf8')),
);

/** Comments blanked out: a rule is a declaration, and the sheet's prose is not one. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}
const sheet = withoutComments(marginalia);

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
}

/** The body of the 1023 px step, from its opening to the end of the sheet. */
const narrow = sheet.slice(sheet.indexOf('@media (max-width: 1023px)'));

describe('the four tokens, and where they live', () => {
  it('declares the margin geometry in tokens.css, with one gap = the mark’s target', () => {
    expect(tokens).toContain('--mark-hit: 40px;');
    expect(tokens).toContain('--note-gap: var(--mark-hit);');
    expect(tokens).toContain('--note-w: 188px;');
    expect(tokens).toContain('--note-step: 12px;');
    // BOOK-91: the used width is the design's 188 px, or the channel itself where the centred
    // column leaves less — the note narrows, it is never clipped.
    expect(tokens).toContain(
      '--note-fit: min(var(--note-w), max(0px, calc((100vw - var(--measure)) / 2 - var(--note-gap) - 8px)));',
    );
    // No new type rung and no new colour: the margin adds lengths and nothing else.
    expect(sheet).not.toMatch(/--fs-[a-z0-9-]+\s*:/u);
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(sheet).not.toMatch(/rgba?\(/u);
  });

  it('keeps the column frame as it is: a centred measure, no second frame', () => {
    // BOOK-88/BOOK-91/BOOK-170: the one column is `--measure` (640px — px, not rem, so it does
    // not follow the reader's root font size), and the canvas is the column plus its two
    // gutters — the 1000 px `--column` frame is retired with it.
    expect(tokens).toContain('--measure: 640px;');
    expect(tokens).not.toContain('--column');
    expect(base).toContain('max-width: calc(var(--measure) + 2 * var(--gut));');
    for (const forbidden of ['--shell', '--column', '--measure']) expect(sheet).not.toContain(forbidden);
    // The reading surfaces own no positioning: the channel and its layers are absent, not moved.
    for (const css of reading) expect(css).not.toMatch(/position:\s*(fixed|absolute)/u);
  });
});

describe('the measured guard (BOOK-DOC-47 §7)', () => {
  it('gives the note up to the strip when the channel does not fit — by measurement', () => {
    // The pass writes `data-margin` per paragraph; this is not a second breakpoint.
    expect(declarations(sheet, ".p[data-margin='strip'] .margin-note")).toContain('display: none');
    expect(declarations(sheet, ".p[data-margin='strip'] .phone-strip")).toContain('display: block');
    // The old object's phone sheet is gone: no selector, no fixed layer, no second surface.
    expect(declarations(sheet, ".p[data-margin='strip'] .revision")).toBe('');
    expect(sheet).not.toContain('.revision');
    expect(sheet).not.toContain('position: fixed');
    expect(sheet).not.toMatch(/@media[^{]*(min-width|width\s*>=)/u);
  });
});

describe('the note is outside the prose and cannot move it', () => {
  it('is absolutely positioned from the prose’s right edge, at the channel’s width', () => {
    const note = declarations(marginalia, '.margin-note');
    expect(note).toContain('position: absolute');
    expect(note).toContain('left: calc(100% + var(--note-gap))');
    // BOOK-91: `--note-fit` — 188 px while the channel holds it, the channel itself at 1024.
    expect(note).toContain('width: var(--note-fit)');
    expect(note).toContain('padding: 6px 0 8px');
    expect(note).toContain('border-top: 1px solid var(--rule)');
    // The box is one button; the quote is two clamped lines of the book's serif.
    const quote = declarations(marginalia, '.margin-note-quote');
    expect(quote).toContain('-webkit-line-clamp: 2');
    expect(quote).toContain('font-size: var(--fs-note)');
    // Nothing here is 11 px or a keyword, and no hover information exists.
    expect(sheet).not.toMatch(/:hover/u);
  });

  it('reveals itself with opacity only, after the pass has written the top', () => {
    expect(declarations(marginalia, '.margin-note')).toContain('opacity: 0');
    expect(declarations(marginalia, ".margin-note[data-placed='true']")).toContain('opacity: 1');
    expect(declarations(marginalia, '.margin-note')).toContain('transition: opacity var(--dur-tick) var(--ease-out)');
    // No animated geometry anywhere in the sheet.
    expect(sheet).not.toMatch(/transition:[^;]*\b(top|height|width)\b/u);
  });

  it('never clips: the page, the chapter and the note carry no overflow', () => {
    for (const css of [base, book, marginalia]) expect(css).not.toMatch(/\.page[^{]*\{[^}]*overflow/u);
    expect(declarations(marginalia, '.margin-note')).not.toContain('overflow: hidden');
    // The tail exists in flow and starts at 0 height (the pass grows it).
    expect(declarations(marginalia, '.margin-tail')).toContain('display: block');
  });
});

describe('the mark keeps the note’s measure, and the object is gone', () => {
  it('has no revision object in the margin: no selector, no absolute placement, no shadow', () => {
    // The object is not relocated to a second selector either: the whole channel is absent.
    expect(declarations(marginalia, '.revision')).toBe('');
    expect(marginalia).not.toContain('.revision');
    expect(declarations(marginalia, '.margin-note')).not.toContain('box-shadow');
  });

  it('keeps the glyph off the prose: the box starts at the edge, the numeral 4 px inside', () => {
    expect(declarations(marginalia, '.filing-mark')).toContain('padding: 0 0 0 4px');
    expect(declarations(marginalia, '.filing-mark-num')).toContain('padding: 1px 0');
    // The phone tick sits 2 px inside the 24 px target (the design's 368 in [366, 390]).
    expect(declarations(narrow, '.filing-mark')).toContain('padding-left: 2px');
  });
});

describe('the phone strip', () => {
  it('is one 44 px row per filing, left-aligned and never justified', () => {
    const row = declarations(marginalia, '.phone-strip-row');
    expect(row).toContain('min-height: 44px');
    expect(row).toContain('padding: 0 8px');
    expect(row).toContain('text-align: left');
    expect(row).toContain('white-space: nowrap');
    const strip = declarations(marginalia, '.phone-strip');
    expect(strip).toContain('text-align: left');
    expect(strip).toContain('white-space: nowrap');
    expect(declarations(narrow, '.phone-strip')).toContain('display: block');
    // The desktop hides the strip; the note is the desktop object.
    expect(strip).toContain('display: none');
  });

  it('never scrolls sideways and carries no count or badge', () => {
    expect(sheet).not.toMatch(/overflow-x/u);
    // The strip itself never scrolls: only the phone sheet may (it is a fixed surface).
    for (const selector of ['.phone-strip', '.phone-strip-row', '.phone-strip-word']) {
      expect(declarations(sheet, selector)).not.toMatch(/overflow:\s*(auto|scroll)/u);
    }
    // The only flexible cell is the state word, and it ellipsises (a clamp with no door is
    // forbidden — the whole fact lives in the opened object).
    expect(declarations(marginalia, '.phone-strip-word')).toContain('text-overflow: ellipsis');
    expect(marginalia).not.toMatch(/\.phone-[a-z-]*badge/u);
  });
});

describe('one breakpoint', () => {
  it('steps at 1023 and never at min-width', () => {
    expect(sheet).toContain('@media (max-width: 1023px)');
    expect(sheet).not.toMatch(/@media[^{]*min-width/u);
    // The phone sheet for the object is gone with the object: no fixed box in the step.
    expect(declarations(narrow, '.revision')).toBe('');
    expect(narrow).not.toContain('position: fixed');
    expect(reading.join('\n')).not.toMatch(/position:\s*(fixed|absolute)/u);
  });
});
