// @vitest-environment jsdom
import type { CatalogEntry, ChapterDto, CommentDto, StateSnapshot } from '@book/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { spineMarkers } from '../lib/spine.ts';
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
  chapters: { total: 67, written: [], empty: [], count: 0, totalChars: 0, basis: [67] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 67, cursor: 1, next: 2, status: 'idle', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: 67, to: 1, cursor: 67, next: 66, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 1, backwardFront: 67, gap: 0, converged: false, seam: 'not_reached' },
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

/** One written chapter, three empty ones, the frozen last slot — the whole reading surface. */
const CATALOG: CatalogEntry[] = Array.from({ length: 67 }, (_, index) => {
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
  if (n === 67) return slot(n, { basis: true, blocks: 1 });
  return slot(n);
});

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
];

/** A count of chapters is a count: `67 глав`, `3 главы с текстом`, `написано 2 из 67`. */
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
function page(): ReactElement {
  return (
    <>
      <Header state={STATE} ribbon={null} catalog={CATALOG} markers={[]} onOpenChange={() => undefined} live />
      <TableOfContents catalog={CATALOG} state={STATE} currentChapter={null} />
      <ChapterList
        catalog={CATALOG}
        revisions={{}}
        revising={{}}
        markers={spineMarkers(STATE)}
        fresh={null}
        chapterFeed={{ 3: { items: [PREMISE], loaded: true } }}
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

async function mount(): Promise<void> {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root?.render(page()));
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

describe('the reading surface prints the book, not the product', () => {
  it('prints no status, count or explanation in the running head', async () => {
    await mount();
    expectNoInterfaceCopy('.top');
  });

  it('prints no status, count or explanation in the flow of chapters', async () => {
    await mount();
    expectNoInterfaceCopy('main');
  });

  it('prints no status, count or explanation in the contents', async () => {
    await mount();
    expectNoInterfaceCopy('#toc');
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
});
