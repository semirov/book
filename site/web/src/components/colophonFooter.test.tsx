import {
  IMPRINT_AUTHOR,
  IMPRINT_COPYRIGHT,
  type BookCostDto,
  type StateSnapshot,
  type ViewerDto,
} from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { costLine, costMoney } from '../lib/bookCost.ts';
import { Colophon } from './Colophon.tsx';
import { firstDeclarations, hasRule, mediaBlockList, mediaBlocks, unionDeclarations } from './cssRules.ts';
import { BASE, TOKENS, tokenPx } from './measure.guard.ts';

/**
 * The footer's two last rows — the way out (BOOK-115) and the outlay (BOOK-114): how they read
 * and how they fit.
 *
 * A sibling of `colophon.test.tsx`, which owns the imprint and the order of the rows: the markup
 * and the sheet claims below would push one file past the house limit of 500 lines. The colophon
 * is read as one document; its tests are two because a file is a unit of the build, not of the
 * reading.
 */

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** One declaration of a rule as a number of px, `em` resolved against the rule's own size. */
function px(css: string, selector: string, property: string, emPx: number): number {
  const raw = new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)(em|px)`, 'u').exec(
    unionDeclarations(css, selector),
  );
  const value = Number.parseFloat(raw?.[1] ?? '0');
  return raw?.[2] === 'em' ? value * emPx : value;
}

const state = {
  chapters: { total: 42, written: [], empty: [], count: 0, totalChars: 0 },
} as unknown as StateSnapshot;

/** The theme is read from the document at first paint; the test renders without a browser. */
function stubDocument(): void {
  vi.stubGlobal('document', {
    documentElement: { getAttribute: () => 'night', setAttribute: () => undefined },
    querySelector: () => null,
  });
}

/** The footer alone, with its optional rows under the caller's control. */
function renderFooter(
  extra: {
    viewer?: ViewerDto;
    cost?: BookCostDto | null;
    donateUrl?: string | null;
    exportBytes?: number | null;
  } = {},
): string {
  stubDocument();
  const html = renderToStaticMarkup(
    <Colophon
      state={state}
      imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }}
      viewer={extra.viewer ?? { signedIn: false, displayName: null }}
      cost={extra.cost ?? null}
      donateUrl={extra.donateUrl ?? null}
      exportBytes={extra.exportBytes ?? null}
    />,
  );
  const start = html.indexOf('<footer');
  const end = html.indexOf('</footer>');
  if (start < 0 || end < 0) throw new Error('the colophon has no footer');
  return html.slice(start, end);
}

/** The text a reader sees: React's separator comments and runs of ASCII whitespace go — the
 *  non-breaking space is a character of the line, not layout, and must survive the comparison. */
function seenText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<[^>]*>/gu, '')
    .replace(/[ \t\n\r]+/gu, ' ')
    .trim();
}

/** A measured outlay; overrides make the unpriced shape. */
function costFixture(overrides: Partial<BookCostDto> = {}): BookCostDto {
  return {
    tokens: 1_234_567,
    tokensIn: 1_000_000,
    tokensOut: 234_567,
    steps: 9,
    usd: 12.34,
    unpriced: [],
    ...overrides,
  };
}

describe('the way out (BOOK-115)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // BOOK-115 AC1 — one sentence, the reader's own name, and the verb as a real button at the
  // end of the row: nothing after the button, because nothing follows the act of leaving.
  it('prints «вы — имя · выйти» with the button last in its row', () => {
    const footer = renderFooter({ viewer: { signedIn: true, displayName: 'Филипп' } });
    const row = /<span class="logout-row">([\s\S]*?)<\/span>/u.exec(footer);
    if (row === null) throw new Error('the colophon has no logout row');
    const inner = row[1] ?? '';
    expect(seenText(inner)).toBe('вы — Филипп · выйти');
    // A button, not a link: the session is ended by a POST, never by navigation.
    expect(inner).toContain('<button type="button" class="logout"');
    expect(inner).not.toContain('<a ');
    // The row's last child is the button — the name and the separator come before it.
    expect(inner.trimEnd().endsWith('</button>')).toBe(true);
    expect(inner.indexOf('Филипп')).toBeLessThan(inner.indexOf('<button'));
    // The name keeps its case in the source; the register's uppercase is CSS.
    expect(inner).not.toContain('ВЫЙТИ');
  });

  // BOOK-115 AC2 — a signed-in reader with no name is still greeted, never «вы — · выйти».
  it('says «вы вошли · выйти» when the session carries no display name', () => {
    const footer = renderFooter({ viewer: { signedIn: true, displayName: null } });
    expect(seenText(footer)).toContain('вы вошли · выйти');
    expect(footer).not.toContain('вы —  ·');
    expect(footer).not.toContain('вы — ·');
    // A blank name is the same absence.
    const blank = renderFooter({ viewer: { signedIn: true, displayName: '   ' } });
    expect(seenText(blank)).toContain('вы вошли · выйти');
  });

  // BOOK-115 AC3 — the footer offers no way in: a signed-out reader has no row and no error.
  it('prints no logout row and no failure line for a signed-out reader', () => {
    const footer = renderFooter({ viewer: { signedIn: false, displayName: 'Филипп' } });
    expect(footer).not.toContain('logout-row');
    expect(footer).not.toContain('выйти');
    expect(footer).not.toContain('войти');
  });
});

describe('the cost line in the footer (BOOK-114)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // BOOK-114 AC1 — the line is the sentence the pure formatter writes, split in two spans so
  // it may break between the count and the money and nowhere else.
  it('prints the measured outlay as the last line of the page', () => {
    const footer = renderFooter({ cost: costFixture() });
    expect(seenText(footer)).toContain(`израсходовано 1\u00a0234\u00a0567 токенов · 12,34\u00a0$`);
    expect(footer.match(/class="cost-line"/gu)).toHaveLength(1);
    // Two fragments: the count with its separator, then the money.
    const line = /<span class="cost-line">([\s\S]*?)<\/span><\/div>/u.exec(footer);
    if (line === null) throw new Error('the colophon has no cost line');
    const parts = [...(line[1] ?? '').replace(/<!--[\s\S]*?-->/gu, '').matchAll(/<span>([\s\S]*?)<\/span>/gu)].map(
      (match) => match[1],
    );
    expect(parts).toEqual([`израсходовано 1\u00a0234\u00a0567 токенов ·`, `12,34\u00a0$`]);
  });

  // BOOK-114 AC2 — an unknown total is not a zero: before the first read nothing is rendered,
  // neither a row nor a placeholder.
  it('prints no row at all while the total is unknown', () => {
    const footer = renderFooter({ cost: null });
    expect(footer).not.toContain('cost-line');
    expect(footer).not.toContain('израсходовано');
    expect(footer).not.toContain('цена не задана');
    // The default prop is the same absence, not a zero.
    expect(renderFooter()).not.toContain('израсходовано');
  });

  it('names the unpriced state instead of a partial figure', () => {
    const footer = renderFooter({ cost: costFixture({ usd: null, unpriced: ['mystery-llm'] }) });
    expect(seenText(footer)).toContain(`израсходовано 1\u00a0234\u00a0567 токенов · цена не задана`);
    expect(footer).not.toContain('$');
  });
});

describe('the gift row (BOOK-126)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const LINK = 'https://t.tb.ru/pm_short/11T50nT6AL';

  // BOOK-126 AC1 — a deployment that does not ask for gifts says nothing about money.
  it('prints no row and no link at all when no link is configured', () => {
    const footer = renderFooter({ donateUrl: null });
    expect(footer).not.toContain('class="donate"');
    expect(footer).not.toContain('поддержать книгу');
    expect(footer).not.toContain('t.tb.ru');
    // The default prop is the same absence.
    expect(renderFooter()).not.toContain('поддержать книгу');
  });

  // BOOK-126 AC2 — one outbound anchor, the exact validated string, and nothing embedded.
  it('prints exactly one anchor with the validated href and no payment-platform byte', () => {
    const footer = renderFooter({ donateUrl: LINK });
    const anchors = [...footer.matchAll(/<a\b[^>]*class="donate"[^>]*>([\s\S]*?)<\/a>/gu)];
    expect(anchors).toHaveLength(1);
    const tag = anchors[0]?.[0] ?? '';
    expect(tag).toContain(`href="${LINK}"`);
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener noreferrer"');
    // The owner's words, with the real arrow and no icon or counter beside them.
    expect(anchors[0]?.[1]).toBe('поддержать книгу →');
    expect(seenText(footer)).toContain('поддержать книгу →');
    // Nothing of the platform is embedded: no script, no iframe, no pixel.
    for (const embedded of ['<iframe', '<script', '<img', 'data-', 'title=']) {
      expect(footer, embedded).not.toContain(embedded);
    }
    // And the href is the value as configured — no query string invented, no UTM.
    expect(footer.match(/https:\/\/t\.tb\.ru\/pm_short\/11T50nT6AL/gu)).toHaveLength(1);
  });
});

describe('the gift row’s sheet (BOOK-126)', () => {
  // BOOK-126 AC3 — the register's lowercase mono line at the 12 px floor with a 44 px target,
  // and no box of its own: the row is the column, and the underline is the house treatment.
  it('is mono, micro and quiet, with the 44 px target and no padding of its own', () => {
    const book = sheets['../styles/book.css'] ?? '';
    expect(hasRule(book, '.colophon .donate')).toBe(true);
    const rule = unionDeclarations(book, '.colophon .donate');
    expect(rule).toContain('font-family: var(--mono)');
    expect(rule).toContain('font-size: var(--fs-micro)');
    expect(rule).toContain('color: var(--ink-3)');
    expect(rule).toContain('display: inline-flex');
    expect(rule).toContain('align-items: center');
    expect(rule).toContain('min-height: 44px');
    expect(rule).toContain('text-transform: none');
    expect(rule).toContain('letter-spacing: 0.02em');
    expect(rule).not.toMatch(/(?:^|;)\s*padding/u);
    expect(rule).not.toMatch(/(?:^|;)\s*margin/u);
    expect(rule).not.toMatch(/overflow:/u);
    // The underline is the colophon's own link treatment, untouched by this rule.
    expect(rule).not.toContain('text-decoration');
  });
});

describe('the cost line’s sheet (BOOK-114)', () => {
  // BOOK-114 AC3 — the line is the marks' register in mono, tabular, and neither half may
  // break: the number is one word and the currency travels with its figure.
  it('is mono, micro and tabular, with unbreakable fragments', () => {
    const book = sheets['../styles/book.css'] ?? '';
    const line = unionDeclarations(book, '.colophon .cost-line');
    expect(hasRule(book, '.colophon .cost-line')).toBe(true);
    expect(line).toContain('font-family: var(--mono)');
    expect(line).toContain('font-size: var(--fs-micro)');
    expect(line).toContain('color: var(--ink-3)');
    expect(line).toContain('font-variant-numeric: tabular-nums');
    expect(unionDeclarations(book, '.colophon .cost-line > span')).toContain('white-space: nowrap');
    // No box of its own: the row is the column, and the line adds no padding or margin.
    expect(line).not.toMatch(/(?:^|;)\s*padding/u);
    expect(line).not.toMatch(/(?:^|;)\s*margin/u);
    expect(line).not.toMatch(/overflow:/u);
    // No width step touches it: the line reads the same at 390 and at 1440 — in every block of
    // every query, not only the first. `book.css` writes `(max-width: 599px)` twice, and a
    // reader that answered with the first block would scan it twice and the second one never;
    // `mediaBlockList` enumerates them all, and its count against the sheet's own `@media` count
    // is what proves no block went unread.
    const blocks = Object.entries(sheets).flatMap(([file, css]) =>
      mediaBlockList(css).map((block) => ({ file, ...block })),
    );
    expect(blocks).toHaveLength(
      Object.values(sheets).reduce(
        (count, css) => count + [...css.matchAll(/@media\s*\([^)]*\)\s*\{/gu)].length,
        0,
      ),
    );
    // The query the 390 claim rests on is stated at all: a missing one throws here.
    mediaBlocks(book, 'max-width: 599px');
    for (const { file, query, body } of blocks) {
      expect(unionDeclarations(body, '.colophon .cost-line'), `${file} @media (${query})`).toBe('');
    }
  });

  // BOOK-114 AC3 — «fits the column at 390 and at 1440», claimed the way `measure.test.ts`
  // claims the measure: every number below is read from the token or the rule it belongs to, and
  // the copy is built by the formatter the footer actually prints, so a changed line, a changed
  // tracking or a changed token fails here rather than in a screenshot.
  it('fits the 342 px phone column and the 640 px column, and wraps rather than clips', () => {
    const book = sheets['../styles/book.css'] ?? '';
    const micro = tokenPx('--fs-micro', { file: TOKENS });
    // PT Mono's advance is the codebase's own constant (`measure.test.ts`): 0,6em, plus the
    // line's own tracking, which the rule states in em against the same size.
    const advance = 0.6 * micro + px(book, '.colophon .cost-line', 'letter-spacing', micro);
    const phone = 390 - 2 * tokenPx('--gut', { query: 'phone', file: BASE });
    const desk = tokenPx('--measure', { file: TOKENS });
    expect({ micro, phone, desk }).toEqual({ micro: 12, phone: 342, desk: 640 });

    const measured: BookCostDto = {
      tokens: 1_234_567,
      tokensIn: 1_000_000,
      tokensOut: 234_567,
      steps: 9,
      usd: 12.34,
      unpriced: [],
    };
    const unmeasured: BookCostDto = { ...measured, usd: null, unpriced: ['mystery-llm'] };
    const priced = costLine(measured);
    const unpriced = costLine(unmeasured);
    expect(priced.length).toBe(41);
    expect(priced.length * advance).toBeCloseTo(305.04, 2);
    expect(priced.length * advance).toBeLessThan(phone);
    expect(priced.length * advance).toBeLessThan(desk);
    // The unpriced variant is 7 characters longer (`цена не задана` is 14, `12,34 $` is 7), so at
    // 390 it falls to a second line instead of crossing the column edge — a clipped tail would be
    // worse than a second line. Each fragment alone still fits.
    expect(unpriced.length - priced.length).toBe(7);
    expect(unpriced.length * advance).toBeGreaterThan(phone);
    expect(costMoney(unmeasured).length * advance).toBeLessThan(phone);
  });
});

describe('the logout row’s sheet (BOOK-115)', () => {
  // BOOK-115 AC4 — mono at the 12 px floor, the reader's own case, a 44 px target and no second
  // focus ring. The button takes the row's face through `font: inherit` (base.css).
  it('is mono and micro, and gives the button a 44 px target', () => {
    const book = sheets['../styles/book.css'] ?? '';
    const row = unionDeclarations(book, '.colophon .logout-row');
    expect(row).toContain('font-family: var(--mono)');
    expect(row).toContain('font-size: var(--fs-micro)');
    expect(row).toContain('text-transform: none');
    const button = unionDeclarations(book, '.colophon .logout');
    expect(button).toContain('display: inline-flex');
    expect(button).toContain('align-items: center');
    expect(button).toContain('min-height: 44px');
    expect(button).toContain('color: var(--ink)');
    expect(button).toContain('text-decoration: none');
    expect(button).toContain('text-transform: none');
    // The button takes the row's face through the reset — `button { font: inherit }` — so the
    // word is mono without a second `font-family` on `.logout`.
    expect(unionDeclarations(sheets['../styles/base.css'] ?? '', 'button')).toContain('font: inherit');
    // The house error ink, one line under the row, at the 12 px floor.
    const error = unionDeclarations(book, '.colophon .logout-error');
    expect(error).toContain('font-size: var(--fs-micro)');
    expect(error).toContain('color: var(--revise)');
    // The focus ring is the global `:focus-visible`; the row does not replace it.
    expect(book).not.toMatch(/\.logout[^{]*\{[^}]*outline:\s*none/u);
  });
});

describe('the download row (BOOK-138)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const DONATE = 'https://t.tb.ru/pm_short/11T50nT6AL';

  /** The footer's rows in order, each without its own wrapper. */
  function rowsOf(footer: string): string[] {
    return [...footer.matchAll(/<div class="row">([\s\S]*?)<\/div>/gu)].map((match) => match[1] ?? '');
  }

  it('AC — the row sits straight after the imprint row and before the gift row', () => {
    const footer = renderFooter({ donateUrl: DONATE, exportBytes: 1_500_000 });
    const rows = rowsOf(footer);
    const imprint = rows.findIndex((row) => row.includes('imprint-line'));
    const download = rows.findIndex((row) => row.includes('class="export-link"'));
    const donate = rows.findIndex((row) => row.includes('class="donate"'));
    expect(imprint).toBeGreaterThan(-1);
    expect(download).toBe(imprint + 1);
    expect(donate).toBe(download + 1);
    // One row, one anchor: nothing else came with the link.
    expect(footer.match(/class="export-link"/gu)).toHaveLength(1);
  });

  it('AC — carries the same exact anchor as the end matter, with the payload’s size', () => {
    const footer = renderFooter({ exportBytes: 1_500_000 });
    expect(footer).toContain('<a class="export-link" href="/book.fb2" download="">скачать fb2 · 1,5 МБ</a>');
    // A real download, not a handler: the row holds the anchor and nothing else — no button,
    // no script, no icon, no counter.
    const row = rowsOf(footer).find((candidate) => candidate.includes('export-link')) ?? '';
    expect(row.replace(/\s+/gu, ' ').trim()).toBe(
      '<a class="export-link" href="/book.fb2" download="">скачать fb2 · 1,5 МБ</a>',
    );
    for (const gone of ['<button', '<script', '<img', 'onClick']) {
      expect(row, gone).not.toContain(gone);
    }
  });

  it('AC — the row exists without a size too, and prints no number then', () => {
    const footer = renderFooter();
    expect(footer).toContain('<a class="export-link" href="/book.fb2" download="">скачать fb2</a>');
    expect(footer).not.toContain('КБ');
    expect(footer).not.toContain('МБ');
    // And it is a row of its own, not a sentence spliced onto the imprint line.
    expect(rowsOf(footer).some((row) => row.includes('export-link'))).toBe(true);
  });
});

describe('the download row’s sheet (BOOK-138)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // BOOK-138 AC — the register's mono line at the 12 px floor, the quiet ink and the house
  // underline, with no box of its own; the 44 px target states itself at the phone width.
  it('is mono, micro and underlined, with the 44 px phone target and no padding box', () => {
    const chrome = sheets['../styles/chrome.css'] ?? '';
    // The base rule itself, above the queries: `firstDeclarations` is the shared reader's
    // answer for "the rule the sheet states first", and `hasRule` makes its absence loud.
    expect(hasRule(chrome, '.page .export-link')).toBe(true);
    const rule = firstDeclarations(chrome, '.page .export-link');
    expect(rule).toContain('font-family: var(--mono)');
    expect(rule).toContain('font-size: var(--fs-micro)');
    expect(rule).toContain('color: var(--ink-2)');
    expect(rule).toContain('display: inline-flex');
    expect(rule).toContain('align-items: center');
    expect(rule).toContain('text-decoration: underline');
    expect(rule).toContain('text-underline-offset: 4px');
    // The footer is `.colophon`, whose label register is uppercase with 0.12em tracking
    // (`base.css`). The one component must not shout in one place and whisper in the other:
    // its own register is stated here, and the rule that scopes to `.page` is what paints.
    expect(rule).toContain('text-transform: none');
    expect(rule).toContain('letter-spacing: 0.02em');
    expect(rule).not.toMatch(/(?:^|;)\s*padding/u);
    expect(rule).not.toMatch(/(?:^|;)\s*margin/u);
    expect(rule).not.toMatch(/(?:^|;)\s*border/u);
    expect(rule).not.toMatch(/background/u);
    expect(rule).not.toMatch(/overflow:/u);
    // The old second line is gone from every sheet: the edition is not printed on the page.
    expect(chrome).not.toContain('.authors-export-line');
  });

  it('states the 44 px target inside the phone query, and no width step above it', () => {
    const chrome = sheets['../styles/chrome.css'] ?? '';
    // `chrome.css` holds more than one phone block (the sheet's own spread, then the export's
    // target), and the target is stated in the second one: every block of the query is read,
    // not the first, and exactly one of them states the selector — two would be two targets.
    const phones = mediaBlocks(chrome, 'max-width: 599px');
    const stated = phones.map((body) => unionDeclarations(body, '.page .export-link'));
    expect(stated.filter((decl) => decl !== '')).toHaveLength(1);
    expect(stated.join(';')).toContain('min-height: 44px');
    // The base rule — the first rule of that selector, above the query — states no height: the
    // target is a phone rule, like the gift row's.
    expect(hasRule(chrome, '.page .export-link')).toBe(true);
    const base = firstDeclarations(chrome, '.page .export-link');
    expect(base).toContain('display: inline-flex');
    expect(base).not.toMatch(/(?:^|;)\s*min-height/u);
  });

  // BOOK-138: the rule above is scoped to `.page`, so it paints in the footer only because the
  // footer element itself is a `.page`. That chain is pinned here rather than left to the
  // markup's memory: without the class the download would drop back to the colophon's label
  // register in one of its two homes, which is the defect the two declarations above fix.
  it('the footer itself is a page — the class the `.page .export-link` rule scopes to', () => {
    expect(renderFooter()).toMatch(/^<footer class="page sheet colophon"/u);
  });
});
