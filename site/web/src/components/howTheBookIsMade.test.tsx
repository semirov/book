import type { FrontDto, StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HOW_THE_BOOK_IS_MADE, HowTheBookIsMade } from './HowTheBookIsMade.tsx';
import { Opening } from './Opening.tsx';
import * as titleSheet from './TitleSheet.tsx';

/**
 * BOOK-39 — the site's explanation of how the book is made, and the rule that ends it.
 *
 * This block is **about** the book, not **of** it: it names the auditor, the writer and the
 * wave, so it may never enter `manuscript/00-front.md` or `/api/front`'s `about` (the
 * manuscript half of that pin lives in `server/test/parseFront.test.ts`, which reads the file
 * itself). The owner's three paragraphs are pinned character for character here, and the
 * `***` he put between them and the book's words is an `<hr>` in the layout — never a
 * character in any string.
 */

const OWNER_PARAGRAPHS = [
  'Мы пишем книгу без готового плана. Есть начало, конец и шестьдесят семь пустых глав между ними. Читатель предлагает вмешательство; аудитор решает, может ли оно существовать в этом мире; писатель вплетает его в текст. Принятая фраза расходится волной по соседним главам — вперёд и назад, пока история снова не сойдётся.',
  'Прошлое при этом не маскируется, а оформляется: у всякой причины появляется бланк. Иногда документ и сцена совпадают. Иногда — нет.',
  'Авторство здесь не измеряется числом написанных слов. Оно измеряется тем, что дожило.',
];

const front: FrontDto = {
  title: 'Бланк',
  about: 'Материя заметила себя, когда в ней замкнулась петля: состояние, память, предсказание, поправка. Замысел не понадобился.',
  rev: 1,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 0, measuredAt: '2026-10-27T08:00:00Z' },
};

/** Only the fields `Header` reads; the opening renders no inventory above the annotation. */
const state = {
  version: 1,
  at: '',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: front.title, about: front.about, rev: 1, updatedAt: null },
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0 },
  cursors: {},
  toc: [],
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

function textOf(html: string): string {
  return html.replace(/<[^>]*>/gu, '');
}

const html = renderToStaticMarkup(<HowTheBookIsMade />);

describe('how the book is made', () => {
  it("pins the owner's three paragraphs character for character", () => {
    expect(HOW_THE_BOOK_IS_MADE).toEqual(OWNER_PARAGRAPHS);
    expect(HOW_THE_BOOK_IS_MADE).toHaveLength(3);
  });

  it('renders them verbatim, in order, as three plain paragraphs', () => {
    expect(html.match(/<p class="p">/gu)).toHaveLength(3);
    expect(textOf(html)).toBe(OWNER_PARAGRAPHS.join(''));
    for (const paragraph of OWNER_PARAGRAPHS) expect(html).toContain(paragraph);
    // Site copy, set as prose: no heading, no button, no link, no visible label, no markdown.
    expect(html).not.toContain('<h');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('**');
    expect(html).not.toContain('aria-label');
    expect(html).not.toContain('style=');
  });

  it('carries no «***»: the divider is the layout\'s job', () => {
    for (const paragraph of OWNER_PARAGRAPHS) expect(paragraph).not.toContain('***');
    expect(html).not.toContain('***');
  });

  it('comes after the cover and before the book: the rule sits between the two', () => {
    const opening = renderToStaticMarkup(
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
    const cover = opening.indexOf('class="page titul"');
    const made = opening.indexOf('class="page how-made"');
    const rule = opening.indexOf('<hr class="front-rule"');
    const page2 = opening.indexOf('class="page annotation"');
    expect(cover).toBeGreaterThanOrEqual(0);
    expect(made).toBeGreaterThan(cover);
    expect(rule).toBeGreaterThan(made);
    expect(page2).toBeGreaterThan(rule);
    // One divider, an element: it is not a character in the text and carries no style attribute.
    expect(opening.match(/<hr/gu)).toHaveLength(1);
    expect(opening).not.toContain('***');
    expect(opening).not.toContain('style=');
    // The explanation is not page 2: the book's own words start after the rule, alone.
    const afterRule = opening.slice(rule, page2);
    expect(afterRule).not.toContain(OWNER_PARAGRAPHS[0] ?? '');
  });

  it('counts no lines and reinstates no caption (BOOK-39)', () => {
    // The owner's final text does not count the book's lines, so no reader-facing copy may,
    // and the retired caption «Восемь линий…» is not a constant of the cover any more.
    expect(Object.keys(titleSheet)).toEqual(['TITLE_GENRE', 'TITLE_PROMISE', 'TitleSheet']);
    expect(Object.keys(titleSheet)).not.toContain('COVER_CAPTION');
    for (const paragraph of HOW_THE_BOOK_IS_MADE) expect(paragraph).not.toMatch(/восемь|линий/iu);
    expect(titleSheet.TITLE_GENRE).not.toContain('Восемь');
    expect(titleSheet.TITLE_PROMISE).not.toContain('Восемь');
  });
});
