import { FRAME_FIRST_SENTENCE, FRAME_LAST_SENTENCE, type CatalogEntry, type FrontDto, type StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Annotation } from './Annotation.tsx';
import { Opening } from './Opening.tsx';
import { TableOfContents } from './TableOfContents.tsx';
import { COVER_CAPTION, TitleSheet } from './TitleSheet.tsx';

const front: FrontDto = {
  title: 'Земля, которая больше не кормит',
  about: 'Первый абзац аннотации.\n\nВторой абзац аннотации.',
  rev: 1,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
};

function slot(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  const part = (n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4) as CatalogEntry['part'];
  return {
    n,
    part,
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 34 ? 'forward' : 'backward',
    ...overrides,
  };
}

/** The live empty book: 67 slots, `written: []`, basis-only tables at 1 and 67. */
const catalog: CatalogEntry[] = Array.from({ length: 67 }, (_, index) => slot(index + 1)).map((row) => {
  if (row.n === 1 || row.n === 67) return { ...row, basis: true };
  return row;
});

const state = {
  version: 1,
  at: '',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: front.title, about: null, rev: 1, updatedAt: null },
  chapters: { total: 67, written: [], empty: catalog.map((row) => row.n), count: 0, totalChars: 0 },
  cursors: {} as StateSnapshot['cursors'],
  toc: catalog.map((row) => ({ part: row.part, n: row.n, title: row.title, written: false, rev: 0 })),
  meeting: { forwardFront: null, backwardFront: null, gap: 67, converged: false, seam: 'not_reached' },
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
  if (row.n === 1) return { ...row, basis: false, title: 'Половик в тамбуре', written: true, rev: 2, chars: 12 };
  if (row.n === 2) return { ...row, title: null, written: true, rev: 1, chars: 20 };
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
  it('is the title, the signature and the caption — and nothing else', () => {
    expect(textOf(coverHtml())).toBe(
      `Земля, которая больше не кормит${'Филипп Семиров'}${COVER_CAPTION}`,
    );
  });

  it('carries the approved caption exactly once, with no period added', () => {
    const html = coverHtml();
    expect(html.match(/Два почерка пишут навстречу и сходятся в одной букве/gu)).toHaveLength(1);
    expect(COVER_CAPTION).toBe('Два почерка пишут навстречу и сходятся в одной букве');
    expect(COVER_CAPTION.endsWith('.')).toBe(false);
    expect(html).toContain('class="cover-caption"');
  });

  it('carries none of the rejected front-page copy (BOOK-DOC-5 §2)', () => {
    const html = coverHtml();
    for (const gone of [
      'роман',
      'в шестидесяти семи главах',
      'написано',
      'знаков',
      'открытую',
      'линии',
      '©',
      '67',
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
    expect(textOf(html)).toBe(`КнигаФилипп Семиров${COVER_CAPTION}`);
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

  it('renders nothing when the annotation is malformed: no fabricated blurb', () => {
    expect(renderToStaticMarkup(<Annotation front={{ ...front, about: null }} />)).toBe('');
  });
});

/** Every `<li class="toc-row…">…</li>`, in document order. */
function tocRows(html: string): string[] {
  return html.match(/<li class="toc-row[^"]*"[^>]*>[\s\S]*?<\/li>/gu) ?? [];
}

describe('the live table of contents', () => {
  const html = renderToStaticMarkup(<TableOfContents catalog={catalog} state={state} currentChapter={null} />);

  it('has one row per slot: 65 bare numerals, 2 frame sentences, 0 invented labels', () => {
    const rows = tocRows(html);
    expect(rows).toHaveLength(67);

    const withText = rows.filter((row) => row.includes('toc-text'));
    expect(withText).toHaveLength(2);
    expect(withText[0]).toContain(FRAME_FIRST_SENTENCE);
    expect(withText[1]).toContain(FRAME_LAST_SENTENCE);

    const bare = rows.filter((row) => !row.includes('toc-text'));
    expect(bare).toHaveLength(65);
    for (const row of bare) {
      expect(textOf(row).trim()).toMatch(/^\d{2}$/u);
    }
  });

  it('opens only the rows that carry prose; the other 65 are inert', () => {
    const rows = tocRows(html);
    const links = rows.filter((row) => row.includes('<a '));
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="#ch-1"');
    expect(links[1]).toContain('href="#ch-67"');

    for (const row of rows.filter((item) => !item.includes('<a '))) {
      expect(row).not.toContain('href');
      expect(row).not.toContain('tabindex');
      expect(row).toContain('aria-hidden="true"');
    }
  });

  it('names no chapter, draws no leader, no range, no rule and does not repeat the title', () => {
    for (const gone of [
      'Глава',
      'leader',
      'toc-part-range',
      '0 / 67',
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

  it('labels its four parts and puts the closing sentence alone under «часть IV»', () => {
    expect(html.match(/class="toc-part-h"/gu)).toHaveLength(4);
    expect(html).toContain('часть I');
    expect(html).toContain('часть IV');
    const fourth = html.slice(html.indexOf('часть IV'));
    expect(textOf(fourth)).toContain('67');
    expect(fourth).toContain(FRAME_LAST_SENTENCE);
  });

  it('keeps the caret dot on a row the writer is in before its first line lands', () => {
    const html = renderToStaticMarkup(
      <TableOfContents catalog={catalog} state={state} currentChapter={5} />,
    );
    const row = tocRows(html)[4] ?? '';
    expect(row).toContain('toc-dot');
    expect(row).toContain('пишется сейчас');
    expect(row).not.toContain('aria-hidden');
    expect(row).not.toContain('<a ');
    // The dot is the only addition: the row still carries its numeral and no invented text.
    expect(textOf(row).trim()).toBe('05');
  });

  it('keeps the written title line, the untitled written row and the caret dot', () => {
    const written = renderToStaticMarkup(
      <TableOfContents catalog={writtenCatalog} state={state} currentChapter={1} />,
    );
    expect(written).toContain('Половик в тамбуре');
    expect(written).toContain('пишется сейчас');
    // Row 2 is written but has no title line: it still opens its chapter, with no text.
    expect(tocRows(written).filter((row) => row.includes('<a '))).toHaveLength(3);
    expect(tocRows(written)[1]).toContain('class="toc-link"');
    expect(tocRows(written)[1]).not.toContain('toc-text');
  });
});

describe('the opening screen', () => {
  const html = renderToStaticMarkup(
    <Opening
      front={front}
      state={state}
      ribbon={null}
      escalation={[]}
      onOpenChange={() => undefined}
      view="book"
      onViewChange={() => undefined}
    />,
  );

  it('starts with the cover and puts the header and the view switch below the annotation', () => {
    expect(html.startsWith('<section class="page titul"')).toBe(true);
    const cover = html.indexOf('class="page titul"');
    const annotation = html.indexOf('class="page annotation"');
    const header = html.indexOf('class="top"');
    const views = html.indexOf('class="views page"');
    expect(annotation).toBeGreaterThan(cover);
    expect(header).toBeGreaterThan(annotation);
    expect(views).toBeGreaterThan(header);
  });

  it('has no 0/67 band and no status strip above the title', () => {
    expect(html).not.toContain('id="start"');
    expect(html).not.toContain('0 / 67');
    expect(html).not.toContain('class="start');
    expect(html).not.toContain('её пишут в открытую');
    expect(html).not.toContain('facts');
    expect(html.indexOf('class="top"')).toBeGreaterThan(html.indexOf(front.title ?? ''));
  });
});
