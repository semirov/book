// @vitest-environment jsdom
import type { FrontDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { COVER_ALT, TITLE_GENRE, TITLE_PROMISE, TitleSheet } from './TitleSheet.tsx';

/**
 * BOOK-131 — the cover plate on the first sheet (BOOK-DOC-49 §2, BOOK-131 comment #3738).
 *
 * The design settles four things that a screenshot cannot keep honest over time: the plate is the
 * sheet's **second column** and its last child (so the owner's four blocks stay first, in order),
 * the image is a 2:3 plate with a reserved box and no crop, it is never dressed (no shadow, no
 * rounding, no filter, no mat) and it never gets a night rule of its own. The markup half runs in
 * jsdom; the style half reads every sheet as text, because a refusal is a rule's absence.
 */

/** Every stylesheet as text, keyed by path: the plate's refusals are a rule across the set. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const chrome = sheets['../styles/chrome.css'] ?? '';

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u'));
  return match?.[1] ?? '';
}

/** The body of `@media (<query>) { … }`, with nested braces balanced. */
function mediaBody(css: string, query: string): string {
  const start = css.search(new RegExp(`@media \\(${query}\\)\\s*\\{`, 'u'));
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  return '';
}

/** Every selector, in the whole sheet set, that names the plate — with the sheet it lives in. */
function plateRules(): Array<{ file: string; selector: string }> {
  return Object.entries(sheets).flatMap(([file, css]) =>
    // Comments are blanked first: the rule's own refusal list must not read as a selector.
    [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{/gu)]
      .map((match) => (match[1] ?? '').trim())
      .filter((selector) => selector.includes('.cover-plate'))
      .map((selector) => ({ file, selector })),
  );
}

const front: FrontDto = {
  title: 'Бланк',
  about: 'Первый абзац аннотации.',
  rev: 1,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 0, measuredAt: '2026-10-27T08:00:00Z' },
};

/** A value the case cannot proceed without: jsdom types every lookup as possibly missing. */
function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(what);
  return value;
}

/** The sheet as the server renders it, parsed: the plate's place is a question about the markup. */
function sheetDoc(seq = false): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(<TitleSheet front={front} seq={seq} />), 'text/html');
}

const plateOf = (doc: Document): HTMLImageElement =>
  need(doc.querySelector<HTMLImageElement>('img.cover-plate'), 'the sheet has no plate');

describe('the plate is the second column of the title sheet (BOOK-131)', () => {
  it('is the section’s last element child, and the owner’s four blocks keep their order first', () => {
    const doc = sheetDoc();
    const section = need(doc.querySelector('section.titul'), 'the sheet has no section.titul');
    const plate = plateOf(doc);
    // Last child, so the reading order never meets the drawing between two of the owner's lines.
    expect(section.lastElementChild).toBe(plate);
    // Exactly two columns in the markup: the text block, then the plate.
    expect([...section.children].map((node) => node.className)).toEqual(['titul-text', 'cover-plate']);

    const text = need(doc.querySelector('.titul-text'), 'the text block is missing');
    const order = [...text.children].map((node) => (node.tagName === 'H1' ? 'h1' : node.className));
    expect(order).toEqual(['h1', 'author', 'title-genre', 'title-promise']);
    // The text is the owner's, byte for byte, and it is still the sheet's first word.
    const rendered = section.textContent ?? '';
    expect(rendered).toBe(`БланкФилипп Семиров${TITLE_GENRE}${TITLE_PROMISE}`);
    expect(rendered.startsWith('Бланк')).toBe(true);
    // The alt is for assistive tech, not the page: it does not become a caption.
    expect(rendered).not.toContain('Обложка');
    expect(doc.querySelector('figcaption')).toBeNull();
  });

  it('carries a short, honest alt that opens with what the plate is', () => {
    const plate = plateOf(sheetDoc());
    expect(plate.getAttribute('alt')).toBe(COVER_ALT);
    expect(COVER_ALT.length).toBeGreaterThan(0);
    expect(COVER_ALT.startsWith('Обложка')).toBe(true);
    // The drawing is the room, not the author: no name, no place, nothing personal.
    expect(COVER_ALT).not.toContain('Филипп');
  });

  it('reserves the 2:3 box and lists both derivatives, so nothing shifts and nothing is cropped', () => {
    const plate = plateOf(sheetDoc());
    expect(plate.getAttribute('src')).toBe('/cover/cover-640.jpg');
    expect(plate.getAttribute('width')).toBe('1024');
    expect(plate.getAttribute('height')).toBe('1536');
    const srcset = plate.getAttribute('srcset') ?? '';
    expect(srcset).toBe('/cover/cover-640.jpg 426w, /cover/cover-1024.jpg 1024w');
    expect(srcset).toContain('/cover/cover-640.jpg 426w');
    expect(srcset).toContain('/cover/cover-1024.jpg 1024w');
    // The phone declares 320 px of slot while the small file is 426 wide: 1.25× at 390, and a 2×
    // phone honestly takes the 1024 file (656 KB) — the ~200 KB phone derivative does not exist
    // yet (comment #3738 §6). Nothing here claims a density the files do not have.
    expect(plate.getAttribute('sizes')).toBe('(max-width: 599px) 320px, (max-width: 1023px) 218px, 224px');
    expect(plate.getAttribute('sizes')).toContain('320px');
    expect(plate.getAttribute('sizes')).toContain('224px');
    // Above the fold at all four widths: it is eager, decoded off the main thread, and high.
    expect(plate.getAttribute('loading')).toBe('eager');
    expect(plate.getAttribute('decoding')).toBe('async');
    expect(plate.getAttribute('fetchpriority')).toBe('high');
    // Not interactive: no link, no zoom, no caption, no second art direction.
    expect(plate.parentElement?.tagName).toBe('SECTION');
    expect(plate.closest('a')).toBeNull();
    expect(plate.hasAttribute('style')).toBe(false);
  });

  it('is tagged `cover` only for a page load that owns a sequence', () => {
    expect(plateOf(sheetDoc(true)).getAttribute('data-seq')).toBe('cover');
    expect(plateOf(sheetDoc(false)).hasAttribute('data-seq')).toBe(false);
  });
});

describe('the plate’s rule is a refusal list, not a style (BOOK-131 §3, §7)', () => {
  it('is a hairline outside the drawing, at its own ratio, and nothing else', () => {
    const rule = declarations(chrome, '.cover-plate');
    expect(rule).toContain('display: block');
    expect(rule).toContain('width: 100%');
    expect(rule).toContain('height: auto');
    expect(rule).toContain('margin: 0');
    expect(rule).toContain('border: 1px solid var(--rule)');
    expect(rule).toContain('object-fit: contain');
    // No paper behind the drawing: at night the plate's field *is* the page's field.
    expect(rule).toContain('background: none');

    const rest = rule.replace('background: none', '');
    for (const refused of [
      'box-shadow',
      'filter',
      'invert',
      'transform',
      'mix-blend-mode',
      'background',
      'border-radius',
      'object-fit: cover',
      'opacity',
      'max-height',
      'aspect-ratio',
    ]) {
      expect(rest, `the plate must not declare «${refused}»`).not.toContain(refused);
    }
    expect(rule).not.toMatch(/object-fit:\s*cover/u);
  });

  it('is named by exactly one rule in the sheet set, and by no theme selector at all', () => {
    // Night mode must not invert, filter or lighten the drawing: the plate has no night rule —
    // the one rule is the plain `.cover-plate` in chrome.css, and `--rule` flips on its own.
    const rules = plateRules();
    expect(rules).toEqual([{ file: '../styles/chrome.css', selector: '.cover-plate' }]);
    for (const { file, selector } of rules) {
      expect(selector, file).not.toMatch(/data-theme|prefers-color-scheme|night|invert/u);
    }
  });

  it('makes the sheet a spread: text in column 1, the plate in 35% at the sheet’s one line', () => {
    const titul = declarations(chrome, '.titul');
    expect(titul).toContain('display: grid');
    expect(titul).toContain('grid-template-columns: minmax(0, 1fr) 35%');
    expect(titul).toContain('column-gap: 6.25%');
    expect(titul).toContain('row-gap: 40px');
    expect(titul).toContain('align-content: end');
    expect(titul).toContain('align-items: end');
    // The field and its one block of padding survive the change to the grid.
    expect(titul).toContain('min-height: min(67.5vh, 720px)');
    expect(titul).toContain('min-height: min(67.5svh, 720px)');
    expect(titul).toContain('padding: calc(env(safe-area-inset-top) + 24px) 0 8px');
    expect(titul).toContain('text-align: left');
    // The old flex column is gone, not stacked under the grid.
    expect(titul).not.toContain('flex-direction');
    expect(titul).not.toContain('justify-content');

    const text = declarations(chrome, '.titul-text');
    expect(text).toContain('display: flex');
    expect(text).toContain('flex-direction: column');
    expect(text).toContain('min-width: 0');
  });

  it('stacks the plate under the text on the phone, in one column, at the same gap', () => {
    const phone = mediaBody(chrome, 'max-width: 599px');
    expect(phone).not.toBe('');
    const titul = declarations(phone, '.titul');
    expect(titul).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(titul).toContain('column-gap: 0');
    // The phone is a narrowing of the same sheet: no second plate rule, no per-breakpoint size.
    expect(phone).not.toContain('.cover-plate');
    expect(declarations(phone, '.cover-plate')).toBe('');
  });
});
