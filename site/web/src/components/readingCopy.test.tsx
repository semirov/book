// @vitest-environment jsdom
import {
  FRAME_LAST_SENTENCE,
  partOf,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type ChapterDto,
  type CommentDto,
  type PassStageEvent,
  type StateSnapshot,
} from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ribbon } from '../lib/cascade.ts';
import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { MIDDOT } from '../lib/format.ts';
import { spineMarkers } from '../lib/spine.ts';
import { EMPTY_SLOT_TEXT } from '../lib/toc.ts';
import { inFlightOf, type Stages, type StagesLog } from '../lib/useStages.ts';
import { ChapterList } from './ChapterList.tsx';
import { Header } from './Header.tsx';
import { TableOfContents } from './TableOfContents.tsx';

/**
 * The reading surface prints the book, not the product.
 *
 * On the book page — the running head (`.top`), the flow of chapters and empty slots (`main`),
 * the contents (`.toc`) — only the book's own text, chapter numbers, the folio and the running
 * head's chapter number and a real chapter title may appear. State words, statuses, counts,
 * explanations of the interface and waits/failures belong to panels, the chronicle and the end
 * matter. This guard renders all three surfaces against a fixture in which **every chip variant
 * would fire** (engine `unknown`, chapter count 0), so a state line cannot slip back in unseen.
 *
 * The fixture's premise quote and prose deliberately avoid the banned vocabulary: the quote is
 * the reader's own words and must never be mistaken for a label. The negative assertions are
 * paired with positive ones — a fix that deletes the book is not a fix.
 *
 * ONE exception (BOOK-156 #3814, owner 2026-10-28): while a pass is in flight the head prints
 * `книга пишется · глава N · HH:MM` in its free space — the book's state, in the owner's words,
 * and nothing else. It is asserted literally below, and the idle head is asserted to print no
 * such line at all: the exception is a state, not a status row that is always there.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SENTENCE = 'Он вошёл в комнату и закрыл за собой дверь.';
const TITLE = 'Начало';
const QUOTE = 'пусть дверь останется открытой до утра';

const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-27T12:00:00Z',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-27T10:00:00Z' },
  chapters: { total: 42, written: [], empty: [], count: 0, totalChars: 0, basis: [42] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 21, cursor: 1, next: 2, status: 'idle', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: 42, to: 22, cursor: 42, next: 41, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 1, backwardFront: 42, gap: 0, converged: false, seam: 'not_reached' },
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
  history: { live: false, readerChanges: 0, started: false },
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

/**
 * One written chapter with a title line, one written chapter without one, three empty slots and
 * the frozen last slot — the whole reading surface, including the case BOOK-137 fixed: a
 * written chapter's contents row is never a bare number.
 */
const CATALOG: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  if (n === 1) {
    return slot(n, {
      title: TITLE,
      rev: 2,
      chars: SENTENCE.length,
      blocks: 1,
      written: true,
      writtenAt: '2026-10-27T09:00:00Z',
      updatedAt: '2026-10-27T09:00:00Z',
    });
  }
  if (n === 2) {
    return slot(n, {
      rev: 1,
      chars: SENTENCE.length,
      blocks: 1,
      written: true,
      // No title line: the contents print the first five words of the prose (owner, 2026-10-28).
      opening: 'Он вошёл в комнату и…',
      writtenAt: '2026-10-27T09:30:00Z',
      updatedAt: '2026-10-27T09:30:00Z',
    });
  }
  if (n === TOTAL_CHAPTERS) return slot(n, { basis: true, blocks: 1 });
  return slot(n);
});

/**
 * BOOK-137 — a ripple whose wings never opened. The running head carries it, and the reading
 * surface prints nothing about it: a wing that never opened is a diagnostic, not reading.
 */
const WAITING_RIBBON: Ribbon = {
  changeId: 'chg_65',
  cascadeId: null,
  chapter: 65,
  wave: 0,
  status: 'open',
  outcome: null,
  touched: [65],
  rewritten: [],
  step: null,
  wings: {
    down: { frontier: 65, wave: 0, state: 'waiting', reached: [] },
    up: { frontier: 65, wave: 0, state: 'waiting', reached: [] },
  },
  frontier: { down: 65, up: 65 },
  seams: [],
};

const PREMISE: CommentDto = {
  attempt: null,
  id: 'cmt_premise',
  chapter: 3,
  anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: QUOTE,
  proposedText: null,
  interventionKind: 'document',
  status: 'delivered',
  frame: 'untouched',
  premise: true,
  reason: null,
  refusal: null,
  createdAt: '2026-10-27T09:10:00Z',
  decidedAt: null,
  changeId: null,
  applied: null,
};

const CHAPTER: ChapterDto = {
  n: 1,
  title: TITLE,
  rev: 2,
  chars: SENTENCE.length,
  basis: false,
  blocks: [{ id: 'ch01#1', i: 0, text: SENTENCE, hash: 'h1' }],
  writtenAt: '2026-10-27T09:00:00Z',
  updatedAt: '2026-10-27T09:00:00Z',
};

/** The second written chapter has prose and no title line of its own (BOOK-137). */
const UNTITLED: ChapterDto = { ...CHAPTER, n: 2, title: null, rev: 1 };

/** The interface's own vocabulary: none of it may reach the three reading surfaces. */
const BANNED = [
  'Книга ·',
  'глав ещё нет',
  'пишется глава',
  'правится глава',
  'последняя запись',
  'тишина с',
  'это замысел главы',
  'не замечание к тексту',
  'первой редакцией',
  '— · —',
  // BOOK-137: a wing that never opened prints nothing at all — no diagnostic on the page.
  'не открылось',
  // Owner, 2026-10-28 — «a status word is not a title». The contents put this one where a
  // chapter's title belongs; it is banned on the whole surface now, and the row shows prose.
  'написана',
];

/**
 * The one deliberate exception (owner, 2026-10-28): «Пусто» is the word the owner chose for an
 * empty chapter's row, so the contents may print exactly that word — and nothing else of the
 * interface's vocabulary. It is a *contents label*, not a state line: it never leaves `#toc`.
 */
const EMPTY_ROW_WORD = 'Пусто';

/** A count of chapters is a count: `42 главы`, `3 главы с текстом`, `написано 2 из 42`. */
const CHAPTER_COUNT = /\d+\s*глав/u;

/** A row's state slot: the numeral followed by the word «замысел» (`02замысел`) — BOOK-112. */
const ROW_STATE_WORD = /\d{2}\s*замысел/u;

/** Comes into view at once, so the written chapter's prose is fetched and set. */
class EagerObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
  } as unknown as Response;
}

let root: Root | null = null;
let container: HTMLDivElement;

/** One reading page: the head, the contents and the flow, exactly as `App` stacks them. */
function page(stages?: Stages, nowMs?: number): ReactElement {
  return (
    <>
      <Header
        state={STATE}
        ribbon={WAITING_RIBBON}
        catalog={CATALOG}
        markers={[]}
        onOpenChange={() => undefined}
        live
        stages={stages}
        nowMs={nowMs}
      />
      <TableOfContents catalog={CATALOG} state={STATE} currentChapter={null} />
      <ChapterList
        catalog={CATALOG}
        revisions={{}}
        revising={{}}
        markers={spineMarkers(STATE)}
        fresh={null}
        chapterFeed={{ 3: { items: [PREMISE], loaded: true } }}
        changes={[]}
        onRead={() => undefined}
        onPosted={() => undefined}
        onProvenance={() => undefined}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        history={false}
      />
    </>
  );
}

/** jsdom has no layout: every slot is a 90 px row, the first one at the top of the page. */
function stackSlots(): void {
  for (const article of document.querySelectorAll<HTMLElement>('article[data-n]')) {
    const n = Number(article.dataset.n);
    article.getBoundingClientRect = () =>
      ({ top: (n - 1) * 90, bottom: (n - 1) * 90 + 90, height: 90, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;
  }
}

async function mount(stages?: Stages, nowMs?: number): Promise<void> {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root?.render(page(stages, nowMs)));
  await act(async () => {
    await Promise.resolve();
  });
  stackSlots();
  // A one-pixel move is a real scroll event: the model commits only a moved reading line.
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 1 });
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function surface(selector: string): string {
  const node = container.querySelector(selector);
  if (node === null) throw new Error(`no surface ${selector}`);
  return node.textContent ?? '';
}

/** A surface must not carry the interface's words — neither phrase nor chapter count. */
function expectNoInterfaceCopy(selector: string): void {
  const text = surface(selector);
  for (const phrase of BANNED) expect(text, `${selector} prints «${phrase}»`).not.toContain(phrase);
  expect(text, `${selector} counts chapters`).not.toMatch(CHAPTER_COUNT);
  expect(text, `${selector} prints a row's state word`).not.toMatch(ROW_STATE_WORD);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/chapters/1')) return json(CHAPTER);
      if (url.endsWith('/api/chapters/2')) return json(UNTITLED);
      // Any other lazy feed is absent in this fixture: an empty book is not an error.
      return json({ code: 'NOT_FOUND', message: 'not found' }, 404);
    }),
  );
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** 14:21 in Moscow: the stage's own moment, and a clock 20 s after it — a live pass, not a wait. */
const LIVE_AT = Date.parse('2026-10-27T11:21:00Z');
const LIVE_NOW = LIVE_AT + 20_000;

/**
 * A pass in flight, built the way the page builds it: the frames folded by `inFlightOf`. The
 * head's own line is the one thing a fixture must never invent, so the log is the real shape.
 */
function liveStages(): Stages {
  const log: Record<number, PassStageEvent[]> = {
    1: [
      {
        passId: 'stp_01J9Z8K4Q7',
        chapter: 1,
        stageSeq: 1,
        stage: 'drafting',
        at: LIVE_AT,
        actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
        changeId: null,
        summary: 'глава пишется',
        span: null,
        tokens: null,
        costUsd: null,
      },
    ],
  };
  const typed: StagesLog = log;
  return { log: typed, passes: inFlightOf(typed), note: () => undefined, reset: () => undefined };
}

describe('the reading surface prints the book, not the product', () => {
  it('prints no status, count or explanation in the running head', async () => {
    await mount();
    expectNoInterfaceCopy('.top');
    // No pass in flight, so no status line at all: the foot's grip carries that fact.
    expect(container.querySelector('.head-status')).toBeNull();
  });

  it('prints the one permitted status — the book is being written — and nothing else', async () => {
    await mount(liveStages(), LIVE_NOW);
    // The exception, literally: the owner's words, the chapter the pass is writing and the
    // stage's own time in Moscow. It is a state line, not a chip: it exists only while a pass
    // runs, and the idle case above proves it is not a permanent row.
    expect(surface('.top')).toContain(`книга пишется${MIDDOT}глава 1${MIDDOT}14:21`);
    expect(container.querySelector('.head-status')?.getAttribute('data-kind')).toBe('live');
    // The rest of the rule stands under the exception: no count, no row's state word, none of
    // the chips the audits removed — the book, the chapter and the folio are still the head.
    expectNoInterfaceCopy('.top');
    expect(container.querySelector('.brand')?.textContent).toBe(STATE.front.title);
  });

  it('prints no status, count or explanation in the flow of chapters', async () => {
    await mount();
    expectNoInterfaceCopy('main');
  });

  it('prints no status, count or explanation in the contents — «Пусто» is the only label', async () => {
    await mount();
    expectNoInterfaceCopy('#toc');
    // The exception is one exact word, in one place, and it is not a sentence: a row's text
    // slot holds the title, the prose's first words, a frame sentence, or this word.
    const texts = [...container.querySelectorAll('#toc .toc-text')].map((node) => node.textContent ?? '');
    expect(texts).toContain(EMPTY_ROW_WORD);
    for (const text of texts) expect(text).not.toContain('написана');
    // ...and it never reaches the reading surface: the empty slot's flow prints no such word.
    expect(surface('main')).not.toContain(EMPTY_ROW_WORD);
  });

  it('keeps no interface state word in any slot, except a held premise’s own waiting word', async () => {
    await mount();
    // The row is a numeral, a leader and — when it holds one — the premise's own quote. BOOK-111
    // (owner, 2026-10-27) adds exactly one thing back: a held premise says it waits, or the
    // reader who already filed reads the slot as empty and is refused as a duplicate.
    const labels = [...container.querySelectorAll('.premise-label')];
    expect(labels).toHaveLength(1);
    expect(labels[0]?.textContent).toBe('ждёт');
    // A row of the flow never prints the state word `замысел`. A premise's quote is the
    // reader's own words, though, and the rule allows them — so quotes are stripped here.
    const flow = (container.querySelector('main')?.cloneNode(true) as Element | null) ?? null;
    for (const quote of flow?.querySelectorAll('.premise-quote') ?? []) quote.remove();
    expect(flow?.textContent ?? '').not.toContain('замысел');
    // The contents prints the state word in no row (BOOK-89 added it; the rule takes it back).
    expect(container.querySelectorAll('#toc .toc-state')).toHaveLength(0);
    for (const text of container.querySelectorAll('#toc .toc-text')) {
      expect(text.textContent?.trim() ?? '').not.toBe('замысел');
    }
    // The head prints the chapter's number and a real title only.
    const word = container.querySelector('.top-chapter-w');
    expect(word?.textContent).toBe(TITLE);
  });

  it('keeps the book: head title, chapter numbers, the written sentence, the quote and the folio', async () => {
    await mount();
    // The brand is the book's own title and nothing else.
    expect(container.querySelector('.brand')?.textContent).toBe(STATE.front.title);
    // The running head names the chapter at the reading line, with its own title.
    expect(container.querySelector('.top-chapter-n')?.textContent).toBe('1');
    expect(container.querySelector('.top-chapter-w')?.textContent).toBe(TITLE);
    // The written chapter keeps its prose; the empty slots keep their numbers.
    const flow = surface('main');
    expect(flow).toContain(SENTENCE);
    for (const n of ['02', '03', '04']) expect(flow).toContain(n);
    // The held premise keeps the reader's own words.
    expect(container.querySelector('#ch-3 .premise-quote')?.textContent).toBe(`«${QUOTE}»`);
    // The contents keeps chapter numbers and the title.
    const toc = surface('#toc');
    expect(toc).toContain('01');
    expect(toc).toContain(TITLE);
    // The folio prints the page the contents calls chapter 1's.
    expect(container.querySelector('.folio')?.textContent).toBe('1');
  });

  it('gives a written chapter its own row text and one word to the empty slot (owner, 2026-10-28)', async () => {
    await mount();
    const row = (n: string): HTMLElement | null =>
      [...container.querySelectorAll<HTMLElement>('#toc .toc-row')].find(
        (element) => element.querySelector('.toc-num')?.textContent === n,
      ) ?? null;
    // A written chapter with no title line shows the book's own first five words, never a state.
    expect(row('02')?.querySelector('.toc-text')?.textContent).toBe('Он вошёл в комнату и…');
    // A written chapter with its own title line keeps the title, never the excerpt beside it.
    expect(row('01')?.querySelector('.toc-text')?.textContent).toBe(TITLE);
    // An empty slot says the one word the owner chose for it — «Пусто» — and nothing else.
    // The deliberate exception to this gate: the label is the contents', not the book's.
    expect(row('03')?.querySelector('.toc-text')?.textContent).toBe(EMPTY_SLOT_TEXT);
    // The frozen slot keeps its frame sentence.
    expect(row('42')?.querySelector('.toc-text')?.textContent).toBe(FRAME_LAST_SENTENCE);
  });
});
