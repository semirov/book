// @vitest-environment jsdom
import {
  directionOf,
  type HistoryTimelineDto,
  partOf,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type CommentDto,
  type ParagraphChainDto,
  type StateSnapshot,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { NBSP } from '../lib/format.ts';
import { historyLive, historyStarted } from '../lib/historyState.ts';
import { wordFacts } from '../lib/provenance.ts';
import type { Ribbon } from '../lib/cascade.ts';
import { Chronicle } from './Chronicle.tsx';
import { Discussion } from './Discussion.tsx';
import { EndMatter } from './EndMatter.tsx';
import { Opening } from './Opening.tsx';
import { ProvenanceBlock } from './ProvenanceBlock.tsx';
import { SentenceBlock } from './SentenceBlock.tsx';
import type { ParagraphChainMode } from '../useParagraphChain.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-56 — one fact, every history surface, and the book's own beginning.
 *
 * The same live-shaped fixture renders three times: an empty log (nothing at all), a begun
 * book (the chronicle and its one starting record, nothing else) and one reader change
 * (everything). Nothing here inspects a CSS class to decide what is hidden — the absent
 * surfaces are absent from the markup, and the kept ones (the cover, page 2, the seam, a
 * filing's own mark) are still there.
 *
 * The starting record is answered by the server, so the state that prints it is mounted
 * rather than stringified: a static render never runs the request the chronicle opens.
 *
 * BOOK-60 narrowed what "history off" hides: the authors list, its note and its shares are
 * history and stay off, while the FB2 download is book matter and stays on the page — reading
 * is never gated. The absence lists below name those surfaces, not the section that now also
 * carries the link.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MID = `${NBSP}·${NBSP}`;

const imprint = { author: 'Филипп Семиров', copyright: '© Филипп Семиров' };

const catalog: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: partOf(n),
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: n === 1 || n === TOTAL_CHAPTERS,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: directionOf(n),
  };
});

/** The two facts the server derives from the log: a reader change, and the book's first row. */
function state(history: { live: boolean; started: boolean }): StateSnapshot {
  return {
    version: 1,
    at: '2026-10-25T12:00:00Z',
    engine: { status: 'unknown', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: 'Бланк', about: 'О чём эта книга.', rev: 1, updatedAt: null },
    chapters: { total: TOTAL_CHAPTERS, written: [], empty: catalog.map((row) => row.n), count: 0, totalChars: 0, basis: [1, TOTAL_CHAPTERS] },
    cursors: {} as StateSnapshot['cursors'],
    toc: catalog.map((row) => ({ part: row.part, n: row.n, title: null, written: false, rev: 0 })),
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
    history: { ...history, readerChanges: history.live ? 1 : 0 },
  };
}

const ribbon: Ribbon = {
  changeId: 'chg_7',
  cascadeId: 'csc_7',
  chapter: 8,
  wave: 2,
  status: 'open',
  outcome: null,
  touched: [7, 8, 9],
  rewritten: [9],
  wings: {
    down: { frontier: 7, wave: 2, state: 'moving', reached: [7] },
    up: { frontier: 9, wave: 2, state: 'moving', reached: [9] },
  },
  step: 9,
  frontier: { down: 7, up: 9 },
  seams: [],
};

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  line: 'переписано в 14:20 правкой 7 (Марк) · было: правка 3 (Аня)',
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 1,
      blockId: 'ch08#0b7e9c31',
      chapter: 8,
      rev: 5,
      at: '2026-10-25T11:20:00Z',
      op: 'revised',
      textHash: '0b7e9c31',
      chars: 112,
      changeId: 'chg_7',
      changeSeq: 7,
      stepId: 'stp_2',
      actor: { kind: 'reader', identityId: 'idt_2', label: 'Марк' },
      replacedBy: null,
    },
  ],
};

const filing: CommentDto = {
  attempt: null,
  id: 'cmt_01J9Z8K4Q7',
  chapter: 8,
  anchor: { blockId: 'ch08#aa11bb22', blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'в комнате должен быть свет, но не от лампы',
  proposedText: null,
  interventionKind: null,
  premise: false,
  status: 'new',
  frame: 'untouched',
  reason: null,
  createdAt: '2026-10-21T12:03:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
      refusal: null,
};

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

const noop = (): void => undefined;

/** The page's one chain mode, as `App` hands it down (BOOK-128 comment #3815). */
const SENTENCE_MODE: ParagraphChainMode = {
  chain: null,
  loading: false,
  failed: false,
  active: false,
  openId: null,
  anchor: null,
  open: noop,
  retry: noop,
  close: noop,
};

/** The same page in every state; only the fixture's two facts differ. */
function page(current: StateSnapshot): string {
  const live = historyLive(current);
  const chronicle = historyStarted(current);
  return renderToStaticMarkup(
    <>
      <Opening
        front={{
          title: 'Бланк',
          about: 'О чём эта книга.',
          rev: 1,
          toc: current.toc,
          imprint,
          authors: { count: 0, measuredAt: '2026-10-25T12:00:00Z' },
        }}
        state={current}
        ribbon={ribbon}
        catalog={catalog}
        escalation={[]}
        onOpenChange={noop}
        view="book"
        onViewChange={noop}
        reading={{ n: null, page: null }}
        live={live}
        chronicle={chronicle}
      />
      {chronicle ? (
        <Chronicle catalog={catalog} frontRev={1} tick={0} started={chronicle} live={live} />
      ) : null}
      {live ? (
        <ProvenanceBlock
          view={wordFacts({ variant: 'machine', actor: null, at: null, share: { kind: 'none' }, filing: null })}
          failed={false}
          onFiling={noop}
        />
      ) : null}
      {live ? (
        <SentenceBlock chain={CHAIN} loading={false} failed={false} quote={TEXT} frame="none" place="flow" onRetry={noop} onClose={noop} />
      ) : null}
      <ProseParagraph
        entry={{ ...catalog[7]!, written: true, blocks: 1 }}
        blockId="ch08#aa11bb22"
        blockIndex={0}
        baseRev={1}
        text={TEXT}
        blockCount={1}
        comments={[filing]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        onPosted={noop}
        sentence={SENTENCE_MODE}
        history={live}
      />
      <EndMatter imprint={imprint} lastRevisionAt="2026-10-25T09:20:00Z" live={live} />
      <Discussion depth={0} changes={[]} comments={[]} live={live} />
    </>,
  );
}

describe('on an empty log the history surfaces are not in the markup (AC1, AC6)', () => {
  const html = page(state({ live: false, started: false }));

  it('renders none of the chronicle, cascade, provenance, apparatus, authors or discussion', () => {
    for (const gone of [
      'class="chronicle',
      'хроника книги',
      'class="chron',
      'class="ribbon',
      'волна',
      'class="prov-block"',
      'class="prov"',
      'class="sentence-block"',
      'печатник',
      'authors-list',
      'authors-note',
      'Авторы',
      'class="page talks"',
      'обсуждение',
      'class="views',
    ]) {
      expect(html, `with an empty log the page must not render «${gone}»`).not.toContain(gone);
    }
    // BOOK-60/BOOK-138: the download is book matter, not history — it stays when the list
    // does not, as a real anchor that saves the file rather than as a request the page makes.
    expect(html).toContain('<a class="export-link" href="/book.fb2" download="">скачать fb2</a>');
  });

  it('keeps the cover, page 2, the byline, the seam door and the filing’s own mark', () => {
    expect(html).toContain('class="page titul"');
    expect(html).toContain('class="page annotation"');
    // The byline stays; «+ 0» is a count of nothing and is gone (BOOK-70).
    expect(html).toContain('Филипп Семиров');
    expect(html).not.toContain('+ 0');
    expect(html).toContain('class="seam-rail"');
    // A filing's mark is the current state, not the log: it stays when history is off.
    expect(html).toContain('class="filing-mark');
    // BOOK-128 comment #3815 — both layers are marginalia behind a door, and with history off
    // the door is not rendered at all (a door to an empty room is worse than no door). What
    // stays is the text's own way in: the rail.
    expect(html).not.toContain('откуда это слово');
    expect(html).not.toContain('откуда эта фраза');
    expect(html).not.toContain('class="prov-block"');
    expect(html).toContain('class="seam-rail"');
  });
});

describe('a pending filing is visible at its anchor while history stays off (BOOK-111)', () => {
  const current = state({ live: false, started: false });
  const html = page(current);

  it('a pending filing is visible at its anchor with readerChanges = 0 while history stays off', () => {
    // BOOK-56's gate is `readerChanges > 0`: a pending filing is not history, so it must show
    // at its anchor even though no reader change exists yet.
    expect(current.history.readerChanges).toBe(0);
    expect(historyLive(current)).toBe(false);

    document.body.innerHTML = html;
    const note = document.querySelector('.margin-note');
    expect(note, 'the margin note renders with history off').not.toBeNull();
    expect(note?.textContent ?? '').toContain('ждёт');
    expect(note?.textContent ?? '').toContain('Её освещал яркий свет.');
    // The phone strip is the same object at <1024, and it prints the same word.
    expect(document.querySelector('.phone-strip')?.textContent ?? '').toContain('ждёт');

    // And nothing of the log came with it.
    for (const gone of [
      'class="chronicle',
      'class="ribbon',
      'волна',
      'class="prov-block"',
      'class="sentence-block"',
      'authors-list',
      'authors-note',
      'Авторы',
      'class="page talks',
    ]) {
      expect(html, `with readerChanges = 0 the page must not render «${gone}»`).not.toContain(gone);
    }
    // BOOK-60/BOOK-138: the FB2 download stays — it is not gated by the history flag.
    expect(html).toContain('<a class="export-link" href="/book.fb2" download="">скачать fb2</a>');
  });
});

describe('a begun book has a chronicle with one starting record (BOOK-56)', () => {
  const current = state({ live: false, started: true });
  const html = page(current);

  it('renders the chronicle and its way in, and keeps every other history surface off', () => {
    expect(html).toContain('class="chronicle');
    expect(html).toContain('class="views');
    for (const gone of ['class="ribbon', 'волна', 'class="prov-block"', 'class="sentence-block"', 'authors-list', 'authors-note', 'Авторы', 'class="page talks']) {
      expect(html, `before the first reader change the page must not render «${gone}»`).not.toContain(gone);
    }
    // BOOK-60/BOOK-138: the download is book matter and survives the history gate.
    expect(html).toContain('<a class="export-link" href="/book.fb2" download="">скачать fb2</a>');
  });

  it('answers with one «начало книги» row and one quiet line, and nothing to scrub', async () => {
    // The row is the server's answer, so this state is mounted: the chronicle asks for the
    // timeline on mount and prints what came back.
    const container = mountChronicle();
    await settle();

    const rows = container.querySelectorAll('li.chr-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe(`начало книги${`21.10.2026${MID}09:12`}`);
    expect(container.textContent).toContain('перематывать пока нечего: книга ещё не правила читателем');
    // Not a change dressed as one: no number, no author, no door, no moment to move.
    expect(container.querySelector('.chr-seq')?.textContent).toBe('начало книги');
    expect(container.querySelector('.chr-change')).toBeNull();
    expect(container.querySelector('.scrub')).toBeNull();
    expect(container.querySelector('.chr-ends')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).not.toContain('пока ничего не записано');
  });

  it('lists a pass while `history.live` is false: the record is not the reader’s flag', async () => {
    // BOOK-56's `live` gates the reader-driven apparatus (the chain, the authors, the traces).
    // The chronicle lists the book's changes whatever caused them, so a begun book whose only
    // entries are passes still has a record to read.
    const container = mountChronicle({
      ...timeline(),
      items: [
        {
          id: 'pass:stp_1',
          hseq: 7,
          at: '2026-10-21T06:12:00Z',
          seq: null,
          chapter: 2,
          chapterTitle: null,
          premise: false,
          premiseLanded: false,
          alias: null,
          cause: 'pass',
          status: null,
          outcome: null,
          reason: null,
          changeId: null,
          recordHref: '#ch-2',
          span: null,
        },
      ],
    });
    await settle();

    const rows = container.querySelectorAll('li.chr-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.chr-cause')?.textContent).toBe('писалась');
    expect(rows[0]?.querySelector('.chr-change')?.getAttribute('href')).toBe('#ch-2');
    expect(container.textContent).not.toContain('перематывать пока нечего');
    // The reader-driven surfaces are still off, as `live` says.
    expect(container.querySelector('.chain')).toBeNull();
  });
});

describe('the first reader change turns every surface on (AC3)', () => {
  const html = page(state({ live: true, started: true }));

  it('renders the chronicle, the cascade, the word’s facts and the phrase’s facts', () => {
    expect(html).toContain('class="chronicle');
    expect(html).toContain('class="ribbon');
    expect(html).toContain('волна 2');
    // BOOK-128 comment #3815 — the two layers are marginalia with three facts each, and their
    // words are the book's own, not the panel's: no rows, no table, no uppercase label.
    expect(html).toContain('class="prov-block');
    expect(html).toContain('печатник');
    expect(html).toContain('следа нет');
    expect(html).toContain('class="sentence-block');
    expect(html).toContain('правка · №7');
    expect(html).not.toContain('class="prov-rows"');
    expect(html).not.toContain('class="chain');
    // ADR-044 / BOOK-128 #3863 — the `…` surface is gone: the keyboard door prints nothing.
    expect(html).not.toContain('class="prov"');
    expect(html).toContain('tabindex="0"');
  });

  it('renders the authors list and the discussion, and no second door into the chronicle', () => {
    // BOOK-77 (HEAD side) appends `ym-hide-content`, so the class string is only a prefix.
    expect(html).toContain('class="page authors');
    expect(html).toContain('Авторы');
    // The view switch at the top of the page is the only way into the chronicle; the end
    // matter's «как менялись доли» button sat behind the `live` gate and could never open a
    // begun book's chronicle, so it is gone.
    expect(html).not.toContain('как менялись доли');
    expect(html).toContain('class="page talks');
    expect(html).toContain('class="views');
  });
});

/** `readJson` needs only `ok` and `json()` on the happy path; no jsdom `fetch`/`Response`. */
function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

let root: Root | null = null;

/** The chronicle's own answer: the log's first moment and no entry. */
function timeline(): HistoryTimelineDto {
  return {
    lastHseq: 7,
    lastAt: '2026-10-21T06:12:00Z',
    firstAt: '2026-10-21T06:12:00Z',
    at: '2026-10-25T12:00:00Z',
    items: [],
    nextBefore: null,
  };
}

/** The chronicle alone, mounted: its one starting record is the log's own first moment. */
function mountChronicle(page: HistoryTimelineDto = timeline()): HTMLElement {
  vi.stubGlobal('fetch', () => Promise.resolve(answer(page)));
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => {
    root?.render(<Chronicle catalog={catalog} frontRev={1} tick={0} started live={false} />);
  });
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
