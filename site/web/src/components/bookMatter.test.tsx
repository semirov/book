import { chapterStartPages, FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, pageAt, partOf, TOTAL_CHAPTERS, type CatalogEntry, type FrontDto, type StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Annotation } from './Annotation.tsx';
import { firstDeclarations, mediaBlocks, unionDeclarations } from './cssRules.ts';
import { Opening } from './Opening.tsx';
import { TableOfContents } from './TableOfContents.tsx';
import { TITLE_GENRE, TITLE_PROMISE, TitleSheet } from './TitleSheet.tsx';

/** Every stylesheet as text, keyed by path: the prose measure is a rule across the set. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const front: FrontDto = {
  title: 'Бланк',
  about: 'Первый абзац аннотации.\n\nВторой абзац аннотации.',
  rev: 1,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 0, measuredAt: '2026-10-25T12:00:00Z' },
};

function slot(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: partOf(n),
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 21 ? 'forward' : 'backward',
    ...overrides,
  };
}

/** The live empty book: 42 slots, `written: []`, basis-only tables at the opening and the finale. */
const catalog: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => slot(index + 1)).map((row) => {
  if (row.n === 1 || row.n === TOTAL_CHAPTERS) return { ...row, basis: true };
  return row;
});

const state = {
  version: 1,
  at: '',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: front.title, about: null, rev: 1, updatedAt: null },
  chapters: { total: TOTAL_CHAPTERS, written: [], empty: catalog.map((row) => row.n), count: 0, totalChars: 0 },
  cursors: {} as StateSnapshot['cursors'],
  toc: catalog.map((row) => ({ part: row.part, n: row.n, title: row.title, written: false, rev: 0 })),
  meeting: { forwardFront: null, backwardFront: null, gap: TOTAL_CHAPTERS, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 0,
    byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
} as unknown as StateSnapshot;

const writtenCatalog: CatalogEntry[] = catalog.map((row) => {
  if (row.n === 1) return { ...row, basis: false, title: 'Тестовая глава', written: true, rev: 2, chars: 12 };
  // A written chapter with no title line: the contents print its first five words.
  if (row.n === 2) return { ...row, title: null, written: true, rev: 1, chars: 20, opening: 'Он вошёл в комнату и…' };
  return row;
});

/** The markup of the front page's cover, as the server-side renderer emits it. */
function coverHtml(): string {
  return renderToStaticMarkup(<TitleSheet front={front} />);
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/gu, '');
}

describe('cover', () => {
  it('is the title, the live byline, the category line and the promise — and nothing else', () => {
    expect(textOf(coverHtml())).toBe(`Бланк${'Филипп Семиров'}${TITLE_GENRE}${TITLE_PROMISE}`);
  });

  it('carries the promise verbatim, in plain words, on its own line', () => {
    const html = coverHtml();
    expect(TITLE_PROMISE).toBe(
      'Один читатель — одно вмешательство в день. Твоя фраза может пережить книгу. Или исчезнуть.',
    );
    expect(html.match(/Один читатель — одно вмешательство в день\. Твоя фраза может пережить книгу\. Или исчезнуть\./gu)).toHaveLength(1);
    expect(html).toContain('class="title-promise"');
    // Book matter, not marketing: no button, no arrow, no exclamation, no category label.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('→');
    expect(html).not.toContain('!');
    expect(html).not.toContain('multiplayer');
  });

  it('counts the readers in the byline only when there are survivors (BOOK-70)', () => {
    // A count of nothing is not a count: on the empty book the author stands alone, and «+ 0»
    // — a chip that counts nothing — is gone.
    expect(coverHtml()).not.toContain('+ 0');
    // The author alone: the byline is the name and nothing after it (the uppercase is CSS).
    expect(coverHtml().match(/<p class="author">[^<]*<\/p>/u)?.[0]).toBe('<p class="author">Филипп Семиров</p>');

    const three = renderToStaticMarkup(
      <TitleSheet front={{ ...front, authors: { count: 3, measuredAt: '2026-10-25T12:00:05Z' } }} />,
    );
    // The chip's own text is exactly «+ 3»: the space belongs to the byline, not the chip.
    expect(three).toContain('Филипп Семиров <span class="author-plus">+ 3</span>');
    expect(three).not.toContain('<span class="author-plus"> +');
    expect(textOf(three)).toContain('Филипп Семиров + 3');
    // The surname is the imprint's, never hardcoded in the component.
    const other = renderToStaticMarkup(
      <TitleSheet front={{ ...front, imprint: { ...front.imprint, author: 'Другой Автор' } }} />,
    );
    expect(other).toContain('<p class="author">Другой Автор</p>');
    expect(other).not.toContain('author-plus');
  });

  it('tolerates a first sheet without a count: the author alone, never «undefined» or «+ 0»', () => {
    const html = renderToStaticMarkup(
      <TitleSheet front={{ ...front, authors: undefined } as unknown as FrontDto} />,
    );
    expect(html).toContain('Филипп Семиров');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('author-plus');
  });

  it('carries the owner\'s category line verbatim, once, between the byline and the promise', () => {
    const html = coverHtml();
    expect(TITLE_GENRE).toBe(
      'Литературно-инженерный перформанс: книга пишется публично, а читатели оставляют в ней след.',
    );
    expect(html.match(/Литературно-инженерный перформанс: книга пишется публично, а читатели оставляют в ней след\./gu)).toHaveLength(1);
    expect(html).toContain('class="title-genre"');
    // Book matter in tone (BOOK-39): no eyebrow of uppercase labels, no card, no arrow,
    // no exclamation — and the genre is named once, not twice.
    expect(html.match(/title-genre/gu)).toHaveLength(1);
    expect(html).not.toContain('!');
    expect(html).not.toContain('→');
    // The retired caption is gone from page 1 and is not reinstated anywhere.
    expect(html).not.toContain('Восемь');
    expect(html).not.toContain('линий');
    expect(html).not.toContain('cover-caption');
    // The order the owner set: title, byline, category line, promise.
    const order = ['class="title"', 'class="author"', 'class="title-genre"', 'class="title-promise"'].map(
      (needle) => html.indexOf(needle),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(new Set(order).size).toBe(4);
  });

  it('puts the genre line and the promise on one measure, and no caption rule is left in the sheets', () => {
    // Two caps tuned to two sentences (34ch and 32ch) gave the cover two ragged edges; one cap
    // for both is copy-independent — a `ch` cap sized to a line count is what BOOK-DOC-39 forbids.
    const book = sheets['../styles/book.css'] ?? '';
    const chrome = sheets['../styles/chrome.css'] ?? '';
    expect(firstDeclarations(book, '.title-genre')).toContain('max-width: min(100%, 58ch)');
    expect(firstDeclarations(chrome, '.title-promise')).toContain('max-width: min(100%, 58ch)');
    const caps = Object.keys(sheets)
      .sort()
      .filter((file) => (sheets[file] ?? '').includes('min(100%, 58ch)'));
    expect(caps).toEqual(['../styles/book.css', '../styles/chrome.css']);
    // The retired caption is not a rule anywhere in the sheet set, only an absence.
    for (const file of Object.keys(sheets)) {
      expect(sheets[file], file).not.toContain('cover-caption');
    }
  });

  it('keeps the cover rhythm explicit: 24 / 32 / 24 px between the lines, 64 px after the promise', () => {
    const book = sheets['../styles/book.css'] ?? '';
    const chrome = sheets['../styles/chrome.css'] ?? '';
    expect(firstDeclarations(chrome, '.author')).toContain('margin: 24px 0 0');
    expect(firstDeclarations(book, '.title-genre')).toContain('margin: 32px 0 0');
    expect(firstDeclarations(chrome, '.title-promise')).toContain('margin: 24px 0 0');
    expect(firstDeclarations(book, '.how-made')).toContain('padding-top: 64px');
  });

  it('stops the cover field growing at 720 px, so a tall window leaves no void above the title', () => {
    const titul = firstDeclarations(sheets['../styles/chrome.css'] ?? '', '.titul');
    expect(titul).toContain('min-height: min(67.5vh, 720px)');
    expect(titul).toContain('min-height: min(67.5svh, 720px)');
  });

  it('carries none of the rejected front-page copy (BOOK-DOC-5 §2)', () => {
    const html = coverHtml();
    for (const gone of [
      'роман',
      'в сорока двух главах',
      'написано',
      'знаков',
      'открытую',
      '©',
      'из 42',
      'сорока двух',
      'Восемь',
      'линий',
      'kicker',
      'subtitle',
      'double-rule',
      'premise',
      'ledger',
      'cover-note',
      'copyright',
    ]) {
      expect(html, `the cover must not render «${gone}»`).not.toContain(gone);
    }
  });

  it('falls back to the site label when the title line is missing', () => {
    const html = renderToStaticMarkup(<TitleSheet front={{ ...front, title: null }} />);
    expect(textOf(html)).toBe(`КнигаФилипп Семиров${TITLE_GENRE}${TITLE_PROMISE}`);
  });

  it('is still on first paint and fades only on a real title change', () => {
    expect(coverHtml()).not.toContain('fade-in');
    const changed = renderToStaticMarkup(<TitleSheet front={front} motion={{ token: 1, mode: 'fade' }} />);
    expect(changed).toContain('class="title title-fade"');
  });
});

describe('page 2', () => {
  it('renders the annotation as prose, with the accessible name and no visible label', () => {
    const html = renderToStaticMarkup(<Annotation front={front} />);
    expect(html).toContain('aria-label="о чём эта книга"');
    expect(html).toContain('<p class="p">Первый абзац аннотации.</p>');
    expect(html).toContain('<p class="p">Второй абзац аннотации.</p>');
    // No label, no box, no animation: it reads as the book's first text.
    expect(html).not.toContain('sec-h');
    expect(html).not.toContain('class="lbl"');
    expect(html).not.toContain('fade-in');
    expect(html).not.toContain('о чём эта книга</');
  });

  it('renders a hard-wrapped paragraph as one continuous line, with a single space', () => {
    // The manuscript is hard-wrapped at ~100 characters; inside a paragraph those breaks
    // are soft, or a justified 390 px column keeps a ragged break (the page-2 defect).
    const wrapped = 'Описание входит в описываемое и не\nзамыкается.\n\nВторой абзац\nтоже.';
    const html = renderToStaticMarkup(<Annotation front={{ ...front, about: wrapped }} />);

    expect(html).toContain('<p class="p">Описание входит в описываемое и не замыкается.</p>');
    expect(html).toContain('<p class="p">Второй абзац тоже.</p>');
    expect(html).not.toContain('не\n');
    expect(html).not.toContain('не  ');
    expect(textOf(html)).toBe('Описание входит в описываемое и не замыкается.Второй абзац тоже.');
    // Two paragraphs stay two, and the author's dash is left exactly as typed.
    expect(html.match(/<p class="p">/gu)).toHaveLength(2);
    const dashed = renderToStaticMarkup(<Annotation front={{ ...front, about: 'Конец —\nсчёт.' }} />);
    expect(dashed).toContain('<p class="p">Конец — счёт.</p>');
  });

  it('renders nothing when the annotation is malformed: no fabricated blurb', () => {
    expect(renderToStaticMarkup(<Annotation front={{ ...front, about: null }} />)).toBe('');
  });

  it('reads justified at the desktop measure and ragged-right on the phone, from the one prose rule', () => {
    // The phone defect: `.p` was justified at every width, and `.annotation .p` re-justified
    // page 2 on top of the shared rule, so page 2 kept rivers at 342px. BOOK-DOC-35 §3 keeps
    // that fix but states it the adaptive way: the desktop is the base, the phone is the query.
    const book = sheets['../styles/book.css'] ?? '';
    expect(firstDeclarations(book, '.p')).toContain('text-align: justify');
    // The threshold is pinned: 599px (the 600 step), the same breakpoint as the gutters.
    expect(book).toMatch(/@media \(max-width:\s*599px\)/u);
    // Every block of the query, not the first: the phone rule is read where `book.css` writes it.
    const phone = mediaBlocks(book, 'max-width: 599px').join('\n');
    expect(unionDeclarations(phone, '.p')).toContain('text-align: left');
    // Exactly one justification in the whole sheet set, and it is that block.
    const justified = Object.keys(sheets).filter((file) => (sheets[file] ?? '').includes('text-align: justify'));
    expect(justified).toEqual(['../styles/book.css']);
    expect(book.match(/text-align: justify/gu)).toHaveLength(1);
    // No other stylesheet re-aligns the prose — page 2 follows the same rule.
    for (const [file, css] of Object.entries(sheets)) {
      if (file === '../styles/book.css') continue;
      expect(css, file).not.toMatch(/\.p\s*\{[^}]*text-align/u);
    }
    // The annotation still keeps its own type: the measure is not all it says.
    expect(firstDeclarations(sheets['../styles/chrome.css'] ?? '', '.annotation .p')).toContain(
      'white-space: normal',
    );
  });
});

/** Every `<li class="toc-row…">…</li>`, in document order. */
function tocRows(html: string): string[] {
  return html.match(/<li class="toc-row[^"]*"[^>]*>[\s\S]*?<\/li>/gu) ?? [];
}

/** The digits of a row's page cell (BOOK-89): the one number on the row's right. */
function rowPage(row: string): number | null {
  const digits = /class="toc-page"><span aria-hidden="true">(\d+)</u.exec(row)?.[1];
  return digits === undefined ? null : Number(digits);
}
/** A row's visible reading: its mark-up without the page's `.sr-only` word (BOOK-89). */
const visibleText = (row: string): string => textOf(row.replace(/<span class="sr-only">[\s\S]*?<\/span>/gu, ''));

describe('the live table of contents', () => {
  const html = renderToStaticMarkup(<TableOfContents catalog={catalog} state={state} currentChapter={null} />);

  it('has one row per slot: 2 frame sentences, 40 rows that say «Пусто», 0 invented labels', () => {
    const rows = tocRows(html);
    expect(rows).toHaveLength(TOTAL_CHAPTERS);
    // Every row carries a text slot now (owner, 2026-10-28): «Пусто» for an empty chapter.
    expect(rows.filter((row) => row.includes('toc-text'))).toHaveLength(TOTAL_CHAPTERS);
    const empty = rows.filter((row) => row.includes('toc-row-empty'));
    expect(empty).toHaveLength(TOTAL_CHAPTERS - 2);
    for (const row of empty) expect(visibleText(row).trim()).toMatch(/^\d{2}Пусто\d+$/u);
    expect(html).not.toContain('toc-state');
    expect(html).not.toContain('замысел');
    expect(html).not.toContain('написана');
  });

  it('opens every row, the 40 empty ones included (owner, 2026-10-28)', () => {
    const rows = tocRows(html);
    const links = rows.filter((row) => row.includes('<a '));
    expect(links).toHaveLength(TOTAL_CHAPTERS);
    expect(links[0]).toContain('href="#ch-1"');
    expect(links[TOTAL_CHAPTERS - 1]).toContain(`href="#ch-${TOTAL_CHAPTERS}"`);
    expect(visibleText(links[0] ?? '')).toBe(`01${FRAME_FIRST_SENTENCE}1`);
    expect(visibleText(links[TOTAL_CHAPTERS - 1] ?? '')).toBe(`${TOTAL_CHAPTERS}${FRAME_LAST_SENTENCE}${TOTAL_CHAPTERS}`);
    expect(rowPage(links[0] ?? '')).toBe(1);
    expect(rowPage(links[TOTAL_CHAPTERS - 1] ?? '')).toBe(TOTAL_CHAPTERS);
    // An empty slot is an anchor to its own place in the flow, and it is still exposed.
    const empty = links.filter((row) => row.includes('toc-row-empty'));
    expect(empty).toHaveLength(TOTAL_CHAPTERS - 2);
    for (const row of empty) {
      expect(row).toMatch(/href="#ch-\d+"/u);
      expect(row).toContain('<span class="toc-text">Пусто</span>');
      expect(row).not.toMatch(/^<li[^>]*aria-hidden/u);
    }
  });

  it('names no chapter, no leader glyph, no dash or ellipsis in the markup, and repeats no title', () => {
    for (const gone of [
      'Глава',
      'leader',
      'toc-part-range',
      '0 / 42',
      'названия берутся',
      'toc-heading',
      'toc-label-muted',
      '—',
      '…',
      front.title ?? '',
    ]) {
      expect(html, `the TOC must not render «${gone}»`).not.toContain(gone);
    }
    expect(html).not.toContain('border');
  });

  it('labels its four parts, with the opening row before part I and the finale row after part IV', () => {
    expect(html.match(/class="toc-part-h"/gu)).toHaveLength(4);
    expect(html).toContain('часть I');
    expect(html).toContain('часть IV');
    const rows = tocRows(html);
    expect(rows).toHaveLength(TOTAL_CHAPTERS);
    // The two frames stand outside the parts: four part lists of ten plus the two frame lists.
    expect(html.match(/class="slots"/gu)).toHaveLength(6);
    // ch01 opens the contents, above the first part heading.
    expect(rows[0]).toContain('href="#ch-1"');
    expect(html.indexOf('href="#ch-1"')).toBeLessThan(html.indexOf('часть I'));
    // ch42 closes it, after part IV's own rows: nothing follows the finale row.
    const last = rows.at(-1) ?? '';
    expect(last).toContain(`href="#ch-${TOTAL_CHAPTERS}"`);
    expect(last).toContain(FRAME_LAST_SENTENCE);
    expect(html.indexOf('часть IV')).toBeLessThan(html.lastIndexOf(`href="#ch-${TOTAL_CHAPTERS}"`));
    // Stripped of the four part blocks, exactly the two frame rows remain.
    const outside = html.replace(/<div class="toc-part">[\s\S]*?<\/div>/gu, '');
    expect(tocRows(outside)).toHaveLength(2);
    expect(tocRows(outside)[0]).toContain('href="#ch-1"');
    expect(tocRows(outside)[1]).toContain(`href="#ch-${TOTAL_CHAPTERS}"`);
  });

  it('marks the current row for assistive tech but draws no caret or arrow', () => {
    const html = renderToStaticMarkup(
      <TableOfContents catalog={catalog} state={state} currentChapter={5} />,
    );
    const row = tocRows(html)[4] ?? '';
    expect(row).not.toContain('toc-dot');
    expect(row).not.toContain('пишется сейчас');
    expect(row).not.toContain('←');
    expect(row).not.toContain('→');
    expect(row).not.toMatch(/^<li[^>]*aria-hidden/u);
    // Its numeral, its own page, no invented title — and a link, like every row now.
    expect(row).toContain('<a ');
    expect(visibleText(row).trim()).toBe('05Пусто5');
    expect(rowPage(row)).toBe(5);
  });

  it('keeps the written title line, the untitled written row and no marker', () => {
    const written = renderToStaticMarkup(
      <TableOfContents catalog={writtenCatalog} state={state} currentChapter={1} />,
    );
    expect(written).toContain('Тестовая глава');
    expect(written).not.toContain('toc-dot');
    expect(written).not.toContain('пишется сейчас');
    expect(written).not.toContain('←');
    // Row 2 is written but untitled: it shows its first five words, not a state word.
    expect(tocRows(written).filter((row) => row.includes('<a '))).toHaveLength(TOTAL_CHAPTERS);
    expect(tocRows(written)[1]).toContain('class="toc-link"');
    expect(tocRows(written)[1]).toContain('<span class="toc-text">Он вошёл в комнату и…</span>');
    expect(written).not.toContain('написана');
  });

  it('prints the start page of every row from one chapterStartPages count — the folio’s digits (AC3)', () => {
    const starts = chapterStartPages(catalog);
    tocRows(html).forEach((row, index) => {
      // The folio derives with `pageAt`; at a chapter's first character that is its start page.
      expect([rowPage(row), rowPage(row)]).toEqual([starts.get(index + 1), pageAt(catalog, index + 1, 0)]);
    });
  });

  it('sets the row as numeral, text, page — and an empty slot says «Пусто» in the text slot', () => {
    const titled = catalog.map((item) =>
      item.n === 7 ? { ...item, written: true, title: 'Начало смены', rev: 1, chars: 50 } : item,
    );
    const markup = renderToStaticMarkup(<TableOfContents catalog={titled} state={state} currentChapter={null} />);
    const row = tocRows(markup)[6] ?? '';
    expect(visibleText(row).trim()).toBe('07Начало смены7');
    expect(rowPage(row)).toBe(chapterStartPages(titled).get(7));
    expect(row).not.toContain('·');
    const empty = tocRows(markup)[7] ?? '';
    expect(empty).toContain('toc-row-empty');
    expect(empty).toContain('<span class="toc-text">Пусто</span>');
    expect(visibleText(empty).trim()).toBe('08Пусто8');
    expect(rowPage(empty)).toBe(8);
    // One word and nothing else in the text slot: not a dash, not a second mark-up.
    expect(empty.match(/class="toc-text"/gu)).toHaveLength(1);
  });

  it('speaks the page once per row: the drawn digit is aria-hidden, «страница N» is not', () => {
    const rows = tocRows(html);
    rows.forEach((row, index) => {
      const page = index + 1;
      // The cell is exactly the drawn (and hidden) digit plus the spoken word: one page text.
      expect(row).toContain(`<span class="toc-page"><span aria-hidden="true">${page}</span><span class="sr-only">страница ${page}</span></span>`);
      const spoken = textOf(row.replace(/<span aria-hidden="true">[\s\S]*?<\/span>/gu, ''));
      expect(spoken.match(new RegExp(`страница ${page}`, 'gu'))).toHaveLength(1);
    });
  });
});

describe('the opening screen', () => {
  const html = renderToStaticMarkup(
    <Opening
      front={front}
      state={state}
      ribbon={null}
      catalog={catalog}
      escalation={[]}
      onOpenChange={() => undefined}
      view="book"
      onViewChange={() => undefined}
    live />,
  );

  it('starts with the cover and puts the header and the view switch below the annotation', () => {
    // BOOK-131: the plate is eager and high-priority, so React 19 hoists its one preload hint
    // above the tree. The page still opens with the cover, and nothing else is hoisted.
    const hoisted = html.match(/^(?:<link[^>]*>)+/u)?.[0] ?? '';
    expect(hoisted).toMatch(/^<link rel="preload" as="image" imageSrcSet="\/cover\/cover-640\.jpg/u);
    expect(hoisted.match(/<link/gu)).toHaveLength(1);
    expect(html.slice(hoisted.length).startsWith('<section class="page titul"')).toBe(true);
    const cover = html.indexOf('class="page titul"');
    const annotation = html.indexOf('class="page annotation"');
    const header = html.indexOf('class="top"');
    const views = html.indexOf('class="views page sheet"');
    expect(annotation).toBeGreaterThan(cover);
    expect(header).toBeGreaterThan(annotation);
    expect(views).toBeGreaterThan(header);
  });

  it('has no 0/42 band and no status strip above the title', () => {
    expect(html).not.toContain('id="start"');
    expect(html).not.toContain('0 / 42');
    expect(html).not.toContain('class="start');
    expect(html).not.toContain('её пишут в открытую');
    expect(html).not.toContain('facts');
    expect(html.indexOf('class="top"')).toBeGreaterThan(html.indexOf(front.title ?? ''));
  });

  it('carries no page number in the server render: the folio is a projection of the scroll', () => {
    // The folio slot is mounted, but a page with no scroll is no page: no guess on the server.
    expect(html).toContain('class="top-row"');
    expect(html).not.toContain('class="folio"');
    expect(html).not.toContain('data-page');
  });
});
