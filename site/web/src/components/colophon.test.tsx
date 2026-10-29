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
import { hasRule, mediaBlockList, mediaBlocks, rules, unionDeclarations } from './cssRules.ts';

/** Every stylesheet as text, keyed by path: whether the source link is printed is a rule
 *  across the set, not of one sheet (`bookMatter.test.tsx` reads the sheets the same way). */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** One sheet of the globbed set. A missing key is an error, not an empty string to assert on. */
function sheet(path: string): string {
  const text = sheets[path];
  if (text === undefined) throw new Error(`the sheet set does not carry ${path}`);
  return text;
}

/**
 * The declarations that take a box or its words off the page — the whole family, not the three
 * that first came to mind: the box (`display`, `visibility`), its content (`overflow`, even the
 * `clip` value, and `clip-path`), its height (`max-height: 0`), its ink (`opacity: 0`) and the
 * trick that pushes the words out of the box (`text-indent`).
 */
const HIDES = [
  /display:\s*none/u,
  /visibility:\s*(?:hidden|collapse)/u,
  /overflow(?:-[xy])?:\s*(?:hidden|clip)\b/u,
  /max-height:\s*0(?:px)?(?![.\d%])/u,
  /clip-path:\s*(?!\s*none\b)/u,
  /\bopacity:\s*0(?:\.0*)?(?![.\d])/u,
  /text-indent:\s*-/u,
] as const;

/** The width steps that would undo what the test above claims, on top of `HIDES`. */
const NARROWS = [/flex-wrap:\s*nowrap/u, /min-height:\s*0(?:px)?(?![.\d%])/u] as const;

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
    // A number carries its noun: «12 глав из 42», never «12 / 42».
    const written = {
      ...state,
      chapters: { ...state.chapters, count: 12 },
    } as unknown as StateSnapshot;
    expect(renderToStaticMarkup(<Colophon state={written} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />)).toContain(
      'книга · 12 глав из 42',
    );
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/rules"');
  });

  // BOOK-225 — the rating, in the footer's own voice: one row, the fact and what it means in
  // the book's words, printed once and never as a badge or a colour.
  it('states the book’s rating in a row of its own', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    expect(footer).toContain('<span class="age-line">18+ · насилие, кровь и взрослые темы</span>');
    expect(footer.match(/class="age-line"/gu) ?? []).toHaveLength(1);
    // Its own row: the rating is not crammed into the imprint's sentence or the counts'.
    const ownRow = [...footer.matchAll(/<div class="row">([\s\S]*?)<\/div>/gu)].filter((match) =>
      (match[1] ?? '').includes('age-line'),
    );
    expect(ownRow).toHaveLength(1);
    expect(ownRow[0]?.[1]).not.toContain('imprint-line');
    // Lowercase register, no exclamation, and no sentence about the reader.
    expect(footer).not.toContain('18+!');
    expect(footer).not.toMatch(/возрастн|несовершеннолетн/iu);
  });

  it('prints no download row while the gate stands (BOOK-225)', () => {
    stubDocument();
    const imprint = { author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT };
    // The footer is still the footer — the book stays discoverable — but the file it offers is
    // refused by the server while gated, so the row is not printed at all.
    const gated = renderToStaticMarkup(<Colophon state={state} imprint={imprint} gated />);
    expect(gated).toContain('class="imprint-line"');
    expect(gated).not.toContain('export-link');
    // A reader past the gate keeps the way to take the book away.
    expect(renderToStaticMarkup(<Colophon state={state} imprint={imprint} />)).toContain('export-link');
  });

  it('states the empty book as a sentence, never as a count of nothing (BOOK-70)', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    expect(html).toContain('книга · глав ещё нет');
    expect(html).not.toContain('0 глав');
    expect(html).not.toContain('из 42');
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
    // The page's only `utm_` surface is that anchor, so the page is claimed too: a second
    // tracked link would honour the exact-href count above and still be a campaign.
    expect(html).not.toContain('utm_');
  });

  // BOOK-78 AC2 — the label is the owner's sentence, character for character and lowercase;
  // the register is the colophon's own (no case transform anywhere, BOOK-128 #3900), so the
  // source and the page agree.
  it('carries the truthful label in the owner\'s words, and nothing beside it', () => {
    const html = renderColophon();
    const { attrs, label } = sourceAnchor(html);
    expect(label).toBe('исходный код сайта открыт');
    // The words in the source, in the case the page prints.
    expect(webSources['./Colophon.tsx']).toContain('исходный код сайта открыт');
    // One fact and nothing more: no trademark, no count, no star, no cheer, no tooltip. The
    // claim is about the link — its attributes and its label — not about every byte of the page.
    expect(attrs).not.toContain('GitHub');
    expect(label).not.toContain('GitHub');
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
  // sheets, not pixels: the anchor is printed (the test above), the row wraps so the extra
  // item can fall to the next line at 390, the anchor is a 24 px underlined target at both
  // widths, and no *`.colophon`* rule — in the flat sheet or in any width step — hides or
  // clips the row, or undoes its wrap. Ancestor selectors are out of scope on purpose:
  // `body { overflow-x: hidden }` is the page's measure, not a clipping of this row, and the
  // same properties on `.sr-only` are that utility's job. It does not prove the layout, only
  // that nothing written for the colophon takes the link away.
  it('keeps its wrap, its 24 px target and never hides the row, from the sheets', () => {
    const book = sheet('../styles/book.css');
    const chrome = sheet('../styles/chrome.css');
    const row = unionDeclarations(book, '.colophon .row');
    const link = unionDeclarations(chrome, '.colophon a');
    // The union is read from real rules: the negative sweep below walks rules that exist.
    expect(hasRule(book, '.colophon .row')).toBe(true);
    expect(hasRule(chrome, '.colophon a')).toBe(true);
    expect(row).toContain('display: flex');
    expect(row).toContain('flex-wrap: wrap');
    expect(link).toContain('display: inline-flex');
    expect(link).toContain('min-height: 24px');
    expect(link).toContain('text-decoration: underline');

    // The list is not a broom: `clip-path: none` states that nothing is clipped, so only a
    // clipping value is forbidden. (The lookahead swallows the space on purpose: without it the
    // `\s*` in front backtracks into a match on `none`.)
    expect(HIDES.some((pattern) => pattern.test('clip-path: none'))).toBe(false);
    expect(HIDES.some((pattern) => pattern.test('clip-path: inset(100%)'))).toBe(true);

    // The sheet set, rule by rule, flat and nested alike — `rules()` reads a rule wherever the
    // sheet writes it, and a selector list is one rule naming several selectors. No rule written
    // for `.colophon` hides the box, clips it, takes its words off the page, or undoes the row's
    // wrap: `flex-wrap: nowrap` in the flat sheet is the same defect as one inside a width step.
    for (const [file, css] of Object.entries(sheets)) {
      for (const [selector, body] of rules(css)) {
        if (!/\.colophon\b/u.test(selector)) continue;
        for (const forbidden of [...HIDES, ...NARROWS]) {
          expect(body, `${file}: ${selector}`).not.toMatch(forbidden);
        }
      }
    }

    // Every width step, every block of it: `book.css` writes `(max-width: 599px)` twice, and a
    // reader that answered with the first block would scan it twice and the second one never.
    // `mediaBlockList` enumerates them all; `mediaBlocks` throws when the phone query the 390
    // claim rests on is absent, so these two calls are the loud failure for a missing block —
    // a length assertion would only restate the throw.
    mediaBlocks(book, 'max-width: 599px');
    mediaBlocks(chrome, 'max-width: 599px');
    const blocks = Object.entries(sheets).flatMap(([file, css]) =>
      mediaBlockList(css).map((block) => ({ file, ...block })),
    );
    // The enumeration is complete, not one-block-per-query: every `@media` of every sheet is a
    // block the sweep below reads.
    expect(blocks).toHaveLength(
      Object.values(sheets).reduce(
        (count, css) => count + [...css.matchAll(/@media\s*\([^)]*\)\s*\{/gu)].length,
        0,
      ),
    );
    // And inside a block the selectors are matched as tokens, so a rule that names the row in a
    // list beside another selector (`.colophon .row, .colophon a { … }`) is read, not skipped.
    for (const { file, query, body } of blocks) {
      for (const selector of ['.colophon .row', '.colophon a']) {
        const found = unionDeclarations(body, selector);
        for (const forbidden of [...HIDES, ...NARROWS]) {
          expect(found, `${file} @media (${query}) ${selector}`).not.toMatch(forbidden);
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
    const book = sheet('../styles/book.css');
    const rule = unionDeclarations(book, '.colophon .build-stamp');
    expect(rule).toContain('font-size: var(--fs-micro)');
    expect(rule).toContain('color: var(--ink-3)');
    // The label register's uppercase is inherited from `.colophon`; the stamp reads as it is.
    expect(rule).toContain('text-transform: none');
  });
});

/**
 * BOOK-115, BOOK-126 — the order of the rows below the imprint line, with the gift
 * row and the build stamp (BOOK-109) between them: who is reading, what the book is, how to
 * support it, which copy it is. The rendering and the sheets of the new rows live
 * in `colophonFooter.test.tsx` — the colophon is read as one document, and its tests are two
 * because a file has a line limit.
 */
describe('the order of the footer (BOOK-109, BOOK-115, BOOK-126)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the logout row, then the imprint, then the gift row, then the build stamp', () => {
    stubDocument();
    const html = renderToStaticMarkup(
      <Colophon
        state={state}
        imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        donateUrl="https://t.tb.ru/pm_short/11T50nT6AL"
        build={{ commit: '5558449', stamp: '27.10 20:52' }}
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
    expect(logout).toBeGreaterThan(-1);
    expect(imprint).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(-1);
    expect(legal).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(-1);
    expect(donate).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(logout).toBeLessThan(imprint);
    // BOOK-138 keeps the download straight after the imprint and the gift straight after the
    // download: those two rows are the reader's way out, and the facts below them — the legal
    // pages, the source, the theme — are what the page says once the reader has them.
    expect(imprint).toBeLessThan(download);
    expect(download).toBeLessThan(donate);
    expect(donate).toBeLessThan(legal);
    expect(legal).toBeLessThan(theme);
    expect(theme).toBeLessThan(build);
    // BOOK-137 — one row per fact: the imprint, the legal pages with the source link, and the
    // theme are three rows, not one crammed line, and each fact is printed once.
    expect(footer.match(/class="imprint-line"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="legal-line"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="theme"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="donate"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="build-stamp"/gu) ?? []).toHaveLength(1);
    expect(footer.match(/class="logout-row"/gu) ?? []).toHaveLength(1);
    // The build stamp is the last row of the page, after both legal links.
    expect(build).toBeGreaterThan(footer.indexOf('href="/privacy"'));
    expect(build).toBeGreaterThan(footer.indexOf('href="/rules"'));
    const rows = [...footer.matchAll(/<div class="row">/gu)];
    expect(rows.length).toBeGreaterThan(0);
    expect(footer.slice(rows.at(-1)?.index ?? 0)).toContain('class="build-stamp"');
  });
});
