import type { CatalogEntry, FrontDto, StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Annotation } from './Annotation.tsx';
import { EmptyState } from './EmptyState.tsx';
import { TableOfContents } from './TableOfContents.tsx';
import { TitleSheet } from './TitleSheet.tsx';

const front: FrontDto = {
  title: 'Земля, которая больше не кормит',
  about: 'Первый абзац аннотации.\n\nВторой абзац аннотации.',
  rev: 1,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
};

const catalog: CatalogEntry[] = Array.from({ length: 67 }, (_, index) => {
  const n = index + 1;
  const part = (n <= 22 ? 1 : n <= 44 ? 2 : n <= 66 ? 3 : 4) as CatalogEntry['part'];
  return {
    n,
    part,
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 34 ? 'forward' : 'backward',
  };
});

const state = {
  version: 1,
  at: '',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Земля, которая больше не кормит', about: null, rev: 1, updatedAt: null },
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
  if (row.n === 1) return { ...row, title: 'Половик в тамбуре', written: true, rev: 2, chars: 12 };
  return row;
});

describe('cover', () => {
  it('renders the live title, the author, the copyright and the 67-chapter line', () => {
    const html = renderToStaticMarkup(<TitleSheet state={state} front={front} />);
    expect(html).toContain('Земля, которая больше не кормит');
    expect(html).toContain('Филипп Семиров');
    expect(html).toContain('© Филипп Семиров');
    expect(html).toContain('67');
    expect(html).toContain('книга пишется в открытую');
  });

  it('falls back to the site label when the title line is missing', () => {
    const html = renderToStaticMarkup(<TitleSheet state={state} front={{ ...front, title: null }} />);
    expect(html).toContain('Книга');
  });
});

describe('page 2', () => {
  it('renders the annotation as prose blocks', () => {
    const html = renderToStaticMarkup(<Annotation front={front} />);
    expect(html).toContain('о чём эта книга');
    expect(html).toContain('<p class="p">Первый абзац аннотации.</p>');
    expect(html).toContain('<p class="p">Второй абзац аннотации.</p>');
  });

  it('renders nothing when the annotation is malformed: no fabricated blurb', () => {
    expect(renderToStaticMarkup(<Annotation front={{ ...front, about: null }} />)).toBe('');
  });
});

describe('the live table of contents', () => {
  it('lists four parts, 67 entries and the live title as its heading', () => {
    const html = renderToStaticMarkup(
      <TableOfContents catalog={catalog} state={state} currentChapter={null} />,
    );
    expect(html).toContain('оглавление');
    expect(html).toContain('часть I');
    expect(html).toContain('часть IV');
    expect(html).toContain('Глава 1');
    expect(html).toContain('Глава 67');
    expect(html.match(/class="slot toc-slot/g)).toHaveLength(67);
    expect(html).toContain('Земля, которая больше не кормит');
  });

  it('shows a chapter title line and marks the chapter being written', () => {
    const html = renderToStaticMarkup(
      <TableOfContents catalog={writtenCatalog} state={state} currentChapter={1} />,
    );
    expect(html).toContain('Половик в тамбуре');
    expect(html).toContain('toc-slot written current');
    expect(html).toContain('пишется сейчас');
  });
});

describe('the 0/67 screen', () => {
  it('reads as a beginning, not as a broken page', () => {
    const html = renderToStaticMarkup(<EmptyState state={state} />);
    expect(html).toContain('книга начинается');
    expect(html).toContain('её пишут с двух концов');
    expect(html).toContain('67 глав');
    expect(html).toContain('четыре части');
    expect(html).toContain('конец фиксирован');
  });

  it('disappears after the first chapter', () => {
    expect(
      renderToStaticMarkup(
        <EmptyState
          state={{ ...state, chapters: { ...state.chapters, count: 1, written: [1] } } as StateSnapshot}
        />,
      ),
    ).toBe('');
  });
});
