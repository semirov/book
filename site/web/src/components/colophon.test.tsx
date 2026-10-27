import {
  IMPRINT_AUTHOR,
  IMPRINT_COPYRIGHT,
  imprintProblems,
  type StateSnapshot,
} from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COLOPHON_MOTTO, Colophon } from './Colophon.tsx';

const state = {
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0 },
} as unknown as StateSnapshot;

/** The theme is read from the document at first paint; the test renders without a browser. */
function stubDocument(): void {
  vi.stubGlobal('document', {
    documentElement: { getAttribute: () => 'night', setAttribute: () => undefined },
    querySelector: () => null,
  });
}

/** The imprint row's own `<span>`, so a match cannot come from another row of the colophon. */
function imprintLine(html: string): string {
  const match = /<span class="imprint-line">([\s\S]*?)<\/span>/u.exec(html);
  if (match === null) throw new Error('the colophon has no .imprint-line span');
  return match[1] ?? '';
}

/**
 * The text a reader sees inside that span: React SSR separates adjacent text nodes with
 * `<!-- -->`, and HTML collapses a run of whitespace to one space, so both go before the
 * comparison — the assertion is about the sentence, not about the serialiser's bookkeeping.
 */
function imprintText(html: string): string {
  return imprintLine(html)
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The web layer as text, the house way (`measure.guard.ts`): the shipped components (every
 * `.tsx` under `src/components`), the entry modules beside `src/`, every `.ts` in `src/lib`
 * and the page shell `web/index.html`. `*.test.*` files are not a reader-facing surface —
 * this file spells the motto out on purpose (AC3 pins it character for character) — so they
 * are filtered out below.
 */
const webSources = import.meta.glob<string>(
  ['./**/*.tsx', '../*.tsx', '../lib/**/*.ts', '../../index.html'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
);

describe('the colophon', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prints the imprint copyright, which the cover no longer carries', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html).toContain(IMPRINT_COPYRIGHT);
    // BOOK-59: no «издание · сегодня» — the imprint has no edition date, and today's date is
    // not one. A clock that ticks while the reader reads dates nothing either.
    expect(html).not.toContain('издание');
    expect(html).not.toMatch(/\d{2}:\d{2}:\d{2}/u);
  });

  it('keeps the counts and the two static pages at the foot of the book', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    // A number carries its noun: «12 глав из 67», never «12 / 67».
    const written = {
      ...state,
      chapters: { ...state.chapters, count: 12 },
    } as unknown as StateSnapshot;
    expect(renderToStaticMarkup(<Colophon state={written} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />)).toContain(
      'книга · 12 глав из 67',
    );
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/rules"');
  });

  it('states the empty book as a sentence, never as a count of nothing (BOOK-70)', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html).toContain('книга · глав ещё нет');
    expect(html).not.toContain('0 глав');
    expect(html).not.toContain('из 67');
    // The owner's copy is untouched.
    expect(html).toContain('печатается по ходу письма');
  });

  // BOOK-94 AC1 — the imprint line is one sentence, verbatim, and the two static pages stay
  // links inside it: «© Филипп Семиров — <motto> · приватность · правила».
  it('renders the imprint line verbatim, with the motto after an em dash (BOOK-94 AC1)', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(imprintText(html)).toBe(
      '© Филипп Семиров — С любовью к научной фантастике и современным технологиям · приватность · правила',
    );
    // The same sentence, read through the constants the page actually prints.
    expect(imprintText(html)).toBe(
      `© ${IMPRINT_AUTHOR} — ${COLOPHON_MOTTO} · приватность · правила`,
    );
    // Both links stay in that one line, not somewhere else in the colophon.
    expect(imprintLine(html)).toContain('href="/privacy"');
    expect(imprintLine(html)).toContain('href="/rules"');
    // The separator is the em dash, not a hyphen or an en dash.
    expect(imprintText(html)).toContain(' — ');
    expect(imprintText(html)).not.toContain(' - ');
    expect(imprintText(html)).not.toContain(' – ');
  });

  // BOOK-94 AC3 — the presentation sentence is pinned character for character, including the
  // capital «С»: a lowercased first letter would pass a `toEqual(COLOPHON_MOTTO)`-only test.
  it('pins the motto, character for character (BOOK-94 AC3)', () => {
    expect(COLOPHON_MOTTO).toBe('С любовью к научной фантастике и современным технологиям');
  });

  // BOOK-94 AC3 — one copy, one print: the page carries the sentence exactly once.
  it('prints the motto exactly once in the rendered colophon (BOOK-94 AC3)', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html.split(COLOPHON_MOTTO).length - 1).toBe(1);
  });

  // BOOK-94 AC3 — and no other surface of the page holds a second copy: the shipped `.tsx`,
  // `src/lib/**/*.ts` and `web/index.html` are globbed as text, and the literal is allowed in
  // `Colophon.tsx` only. Out of scope, on purpose: the top-level `web/src/*.ts` hooks,
  // `server/**`, `shared/**` and the text tree (`manuscript/**`, `bible/**`) — this guard
  // claims the surfaces above, not every file in the tree.
  it('keeps one copy of the motto across the web sources (BOOK-94 AC3)', () => {
    const surfaces = Object.entries(webSources)
      .filter(([file]) => !/\.test\.[jt]sx?$/u.test(file))
      .filter(([, source]) => source.includes(COLOPHON_MOTTO))
      .map(([file]) => file);
    expect(surfaces).toEqual(['./Colophon.tsx']);
  });

  // BOOK-94 AC3 — the guard above is not vacuous: the glob reaches further than the components
  // (a copy in `src/lib/pageTitle.ts` or `index.html` is scanned), which the widened set must
  // keep doing for the guard's scope to be what its comment says.
  it('reads lib, the entry modules and index.html, not only the components (BOOK-94 AC3)', () => {
    const files = Object.keys(webSources);
    expect(files).toContain('./Colophon.tsx');
    expect(files).toContain('../App.tsx');
    expect(files).toContain('../lib/pageTitle.ts');
    expect(files).toContain('../../index.html');
    for (const [file, source] of Object.entries(webSources)) {
      expect(source.length, `${file} read as empty text`).toBeGreaterThan(0);
    }
    // `?raw` really yields the file, not a stub: the page shell's own markup is in the text.
    expect(webSources['../../index.html']).toContain('<div id="root">');
  });

  // BOOK-94 AC2 — the rights statement is untouched and the validator still says it is exact:
  // the motto is presentation, so it never enters `IMPRINT_COPYRIGHT` or the imprint file.
  it('leaves the rights statement exactly as the validator requires (BOOK-94 AC2)', () => {
    expect(IMPRINT_COPYRIGHT).toBe('© Филипп Семиров');
    expect(IMPRINT_COPYRIGHT).not.toContain(COLOPHON_MOTTO);
    expect(
      imprintProblems({ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT, publisher: null, year: 'auto' }),
    ).toEqual([]);
  });
});
