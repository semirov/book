import {
  IMPRINT_AUTHOR,
  IMPRINT_COPYRIGHT,
  imprintProblems,
  type StateSnapshot,
} from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COLOPHON_MOTTO, Colophon } from './Colophon.tsx';
import { state, stubDocument } from './colophon.fixture.ts';

/** Every stylesheet as text, keyed by path: whether the source link is printed is a rule
 *  across the set, not of one sheet (`bookMatter.test.tsx` reads the sheets the same way). */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * The declarations of every rule whose selector is exactly `selector`: the colophon's link is
 * dressed by two consecutive blocks in `chrome.css` (the underline, then the 24 px target),
 * so the helper reads the union rather than the first match.
 */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'gu'))]
    .map((match) => match[1] ?? '')
    .join(';');
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

  // BOOK-94 AC1 — the imprint line is one sentence, verbatim, with the motto after an em dash.
  // BOOK-137 — the two static pages are a row of their own now, so the sentence is not crammed
  // with them; its words are unchanged.
  it('renders the imprint line verbatim, with the motto after an em dash (BOOK-94 AC1)', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(imprintText(html)).toBe(`© ${IMPRINT_AUTHOR} — ${COLOPHON_MOTTO}`);
    // The legal row is its own line, and it is the one that carries the two links.
    const legal = html.slice(html.indexOf('class="legal-line"'), html.indexOf('class="legal-line"') + 400);
    expect(legal).toContain('href="/privacy"');
    expect(legal).toContain('href="/rules"');
    expect(legal).toContain('приватность');
    expect(legal).toContain('правила');
    // The imprint row itself carries no link at all: one row, one fact.
    expect(imprintLine(html)).not.toContain('<a ');
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

/** The colophon of an empty book, as the server prints it. */
function renderColophon(): string {
  stubDocument();
  return renderToStaticMarkup(
    <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
  );
}

/**
 * The one anchor to the repository: its attribute string and its label. Throws when the link
 * is absent, so a deleted link fails here instead of passing an empty comparison.
 */
function sourceAnchor(html: string): { attrs: string; label: string } {
  const match = /<a ([^>]*href="https:\/\/github\.com\/semirov\/book"[^>]*)>([\s\S]*?)<\/a>/u.exec(html);
  if (match === null) throw new Error('the colophon has no link to the source');
  return { attrs: match[1] ?? '', label: match[2] ?? '' };
}

describe('the source link in the end matter (BOOK-78)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // BOOK-78 AC1/AC3 — one link, the literal href, opened in a new tab without an opener.
  // Everything is spelled out here on purpose: a test that compares against a constant the
  // component exports only proves the constant agrees with itself.
  it('is one link to the repository, opened in a new tab without the opener', () => {
    const html = renderColophon();
    expect(html.match(/href="https:\/\/github\.com\/semirov\/book"/gu)).toHaveLength(1);
    const { attrs } = sourceAnchor(html);
    expect(attrs).toContain('href="https://github.com/semirov/book"');
    expect(attrs).toContain('target="_blank"');
    expect(attrs).toContain('rel="noopener noreferrer"');
    // A fact, not a campaign: no query string, no fragment, no tracking hook, no tooltip.
    expect(attrs).not.toContain('?');
    expect(attrs).not.toContain('#');
    expect(attrs).not.toContain('utm_');
    expect(attrs).not.toMatch(/metrika|ym-|data-|onclick|title=/u);
    expect(html).not.toContain('utm_');
  });

  // BOOK-78 AC2 — the label is the owner's sentence, character for character and lowercase;
  // the colophon's shared uppercase transform is presentation, so the source says lowercase.
  it('carries the truthful label in the owner\'s words, and nothing beside it', () => {
    const html = renderColophon();
    const { label } = sourceAnchor(html);
    expect(label).toBe('исходный код сайта открыт');
    // The words in the source, before CSS uppercases the register.
    expect(webSources['./Colophon.tsx']).toContain('исходный код сайта открыт');
    // One fact and nothing more: no trademark, no count, no star, no cheer, no tooltip.
    expect(html).not.toContain('GitHub');
    expect(html).not.toContain('звёзд');
    expect(html).not.toContain('★');
    expect(label).not.toContain('!');
    expect(label).not.toContain('пожалуйста');
  });

  // BOOK-78 decision 2 — the anchor is a sibling right after the imprint sentence's span,
  // before the theme toggle: the licence line stays one sentence, and BOOK-94 pins it.
  it('sits beside the licence line, outside the sentence BOOK-94 pins', () => {
    const html = renderColophon();
    const imprint = html.indexOf('class="imprint-line"');
    const anchor = html.indexOf('href="https://github.com/semirov/book"');
    const theme = html.indexOf('class="theme"');
    expect(imprint).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(-1);
    expect(anchor).toBeGreaterThan(imprint);
    expect(anchor).toBeLessThan(theme);
    // Not inside the pinned span: its text is still the six words of BOOK-94 AC1.
    expect(imprintLine(html)).not.toContain('github.com');
  });

  // BOOK-78 AC1 — «reachable at 390 and 1440» without a browser. This test claims the
  // stylesheet, not pixels: the anchor is printed (the test above), the row wraps so the extra
  // item can fall to the next line at 390, the anchor is a 24 px underlined target at both
  // widths, and no rule in the sheet set hides or clips it at any width. It does not prove the
  // layout, only that nothing in the sheets takes the link away.
  it('keeps its wrap, its 24 px target and never hides the row, from the sheets', () => {
    const book = sheets['../styles/book.css'] ?? '';
    const chrome = sheets['../styles/chrome.css'] ?? '';
    expect(declarations(book, '.colophon .row')).toContain('display: flex');
    expect(declarations(book, '.colophon .row')).toContain('flex-wrap: wrap');
    expect(declarations(chrome, '.colophon a')).toContain('display: inline-flex');
    expect(declarations(chrome, '.colophon a')).toContain('min-height: 24px');
    expect(declarations(chrome, '.colophon a')).toContain('text-decoration: underline');

    // The sheet set, rule by rule: no `.colophon` rule hides a box or clips its content.
    const rules = (css: string): Array<[string, string]> =>
      [...css.replace(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => [
        (match[1] ?? '').replace(/\s+/gu, ' ').trim(),
        match[2] ?? '',
      ]);
    for (const [file, css] of Object.entries(sheets)) {
      for (const [selector, body] of rules(css)) {
        if (!/\.colophon\b/u.test(selector)) continue;
        const where = `${file}: ${selector}`;
        expect(body, where).not.toMatch(/display:\s*none/u);
        expect(body, where).not.toMatch(/visibility:\s*hidden/u);
        expect(body, where).not.toMatch(/overflow:\s*hidden/u);
      }
      // And no width step re-lays the row or strips the link — the wrap is the same at 390
      // and at 1440, because no query touches either selector.
      for (const [, query] of css.matchAll(/@media\s*\(([^)]*)\)\s*\{/gu)) {
        const body = mediaBody(css, query ?? '');
        for (const selector of ['.colophon .row', '.colophon a']) {
          const where = `${file} @media (${query}) ${selector}`;
          expect(declarations(body, selector), where).not.toMatch(
            /display:\s*none|visibility:\s*hidden|overflow:\s*hidden|flex-wrap:\s*nowrap|min-height:\s*0/u,
          );
        }
      }
    }
  });
});

/**
 * BOOK-109 — the build the page is: the one fact that tells two hosts (and a stale cache)
 * apart. It is a row of its own after the imprint line, printed once, in the micro rung.
 */
describe('the build stamp in the end matter (BOOK-109)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWithBuild(): string {
    stubDocument();
    return renderToStaticMarkup(
      <Colophon
        state={state}
        imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }}
        build={{ commit: '5558449', stamp: '27.10 20:52' }}
      />,
    );
  }

  it('prints «сборка <commit> · <stamp>» once, after the imprint line and before the margin tail', () => {
    const html = renderWithBuild();
    expect(html).toContain('<span class="build-stamp">сборка 5558449 · 27.10 20:52</span>');
    // One print: a second copy would be a second claim about the same build.
    expect(html.split('сборка ').length - 1).toBe(1);

    // The row is after the row that carries the imprint sentence — and after the theme toggle
    // in it — and before the margin's tail, which stays the page's last element.
    const stamp = html.indexOf('class="build-stamp"');
    expect(stamp).toBeGreaterThan(html.indexOf('class="imprint-line"'));
    expect(stamp).toBeGreaterThan(html.lastIndexOf('class="theme"'));
    expect(stamp).toBeLessThan(html.indexOf('class="margin-tail"'));
    // Outside the pinned BOOK-94 sentence, whose text is still the six words it pins.
    expect(imprintLine(html)).not.toContain('сборка');
  });

  it('dresses the stamp as a data mark: the micro rung and the quiet ink', () => {
    const book = sheets['../styles/book.css'] ?? '';
    const rule = declarations(book, '.colophon .build-stamp');
    expect(rule).toContain('font-size: var(--fs-micro)');
    expect(rule).toContain('color: var(--ink-3)');
    // The label register's uppercase is inherited from `.colophon`; the stamp reads as it is.
    expect(rule).toContain('text-transform: none');
  });
});

/**
 * BOOK-114, BOOK-115, BOOK-126 — the order of the rows below the imprint line, with the gift
 * row and the build stamp (BOOK-109) between them: who is reading, what the book is, how to
 * support it, which copy it is, what it cost. The rendering and the sheets of the new rows live
 * in `colophonFooter.test.tsx` — the colophon is read as one document, and its tests are two
 * because a file has a line limit.
 */
describe('the order of the footer (BOOK-109, BOOK-114, BOOK-115, BOOK-126)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the logout row, then the imprint, then the gift row, then the build stamp, then the cost line', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon
        state={state}
        imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        donateUrl="https://t.tb.ru/pm_short/11T50nT6AL"
        build={{ commit: '5558449', stamp: '27.10 20:52' }}
        cost={{ tokens: 1_234_567, tokensIn: 1_000_000, tokensOut: 234_567, steps: 9, usd: 12.34, unpriced: [] }}
      />,
    );
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    const logout = footer.indexOf('class="logout-row"');
    const imprint = footer.indexOf('class="imprint-line"');
    const download = footer.indexOf('class="export-link"');
    const legal = footer.indexOf('class="legal-line"');
    const theme = footer.indexOf('class="theme"');
    const donate = footer.indexOf('class="donate"');
    const build = footer.indexOf('class="build-stamp"');
    const cost = footer.indexOf('class="cost-line"');
    expect(logout).toBeGreaterThan(-1);
    expect(imprint).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(legal).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(-1);
    expect(donate).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(cost).toBeGreaterThan(-1);
    expect(logout).toBeLessThan(imprint);
    // BOOK-138 keeps the download straight after the imprint and the gift straight after the
    // download: those two rows are the reader's way out, and the facts below them — the legal
    // pages, the source, the theme — are what the page says once the reader has them.
    expect(imprint).toBeLessThan(download);
    expect(download).toBeLessThan(donate);
    expect(donate).toBeLessThan(legal);
    expect(legal).toBeLessThan(theme);
    expect(theme).toBeLessThan(build);
    expect(build).toBeLessThan(cost);
    // BOOK-137 — one row per fact: the imprint, the legal pages with the source link, and the
    // theme are three rows, not one crammed line, and each fact is printed once.
    expect(footer.match(/class="imprint-line"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="legal-line"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="theme"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="donate"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="cost-line"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="build-stamp"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="logout-row"/gu) ?? []).toHaveLength(1);
    // Nothing follows the cost line: it is the last row of the page, after both legal links.
    expect(cost).toBeGreaterThan(footer.indexOf('href="/privacy"'));
    expect(cost).toBeGreaterThan(footer.indexOf('href="/rules"'));
    const rows = [...footer.matchAll(/<div class="row">/gu)];
    expect(rows.length).toBeGreaterThan(0);
    expect(footer.slice(rows.at(-1)?.index ?? 0)).toContain('class="cost-line"');
  });
});
