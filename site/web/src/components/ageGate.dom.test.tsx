// @vitest-environment jsdom
import {
  directionOf,
  partOf,
  TOTAL_CHAPTERS,
  ageDateOf,
  type CatalogEntry,
  type ChapterDto,
  type FrontDto,
  type StateSnapshot,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App.tsx';
import { AGE_GATE_FORWARD, AGE_GATE_LEAVE, AGE_GATE_LINE, AGE_LABEL } from '../lib/age.ts';

/**
 * BOOK-225 — the rating is asked before any chapter text, and it is a page.
 *
 * This mounts the real `App` on the stubbed socket and REST edge the app tests use, with an
 * observer that puts every slot in view: the chapter flow would fetch its prose the moment it
 * mounted, so «no `GET /api/chapters/1`» below is a fact about the page, not about an observer
 * that never fired.
 *
 * Three states of the same reader: no answer (the gate, and no prose request), the answer
 * (`POST /api/age`, then the prose arrives and the gate is gone), and a device that already
 * answered (the cookie at boot, prose, no gate). The gate's own words are asserted literally,
 * because the owner's copy is the requirement.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = '2026-10-29T12:00:00Z';
const PROSE = 'Он вошёл в комнату и закрыл за собой дверь.';
const TITLE = 'Бланк';

const catalog: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  const written = n === 1;
  return {
    n,
    part: partOf(n),
    title: written ? 'Начало' : null,
    rev: written ? 1 : 0,
    chars: written ? PROSE.length : 0,
    blocks: written ? 1 : 0,
    written,
    basis: false,
    opening: null,
    writtenAt: written ? NOW : null,
    updatedAt: written ? NOW : null,
    direction: directionOf(n),
  };
});

const STATE: StateSnapshot = {
  version: 1,
  at: NOW,
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: TITLE, about: 'О чём эта книга.', rev: 1, updatedAt: NOW },
  chapters: { total: TOTAL_CHAPTERS, written: [1], empty: catalog.map((row) => row.n).filter((n) => n !== 1), count: 1, totalChars: PROSE.length, basis: [] },
  cursors: {} as StateSnapshot['cursors'],
  toc: catalog.map((row) => ({ part: row.part, n: row.n, title: row.title, written: row.written, rev: row.rev })),
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
  history: { live: false, readerChanges: 0, started: false },
};

const FRONT: FrontDto = {
  title: TITLE,
  about: 'О чём эта книга.',
  rev: 1,
  toc: STATE.toc,
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 1, measuredAt: NOW },
  revision: 1,
  exportBytes: 1024,
};

const CHAPTER: ChapterDto = {
  n: 1,
  title: 'Начало',
  rev: 1,
  chars: PROSE.length,
  basis: false,
  blocks: [{ id: 'ch01#1', i: 0, text: PROSE, hash: 'h1' }],
  writtenAt: NOW,
  updatedAt: NOW,
};

type Request = { path: string; method: string };
let requests: Request[] = [];
/** A refused `POST /api/age`, for the case where the gate must not move. */
let ageFails = false;
/** A book whose first sheet has no title, for the gate that must invent none. */
let titleless = false;

function answer(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function fetchStub(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push({ path, method: init?.method ?? 'GET' });
    if (path === '/api/age') {
      return ageFails
        ? ({ ok: false, status: 500, json: async () => ({ code: 'INTERNAL', message: 'internal error' }) } as unknown as Response)
        : answer({ acknowledgedAt: ageDateOf(new Date()) });
    }
    if (path.startsWith('/api/state')) return answer(STATE);
    if (path === '/api/chapters') return answer(catalog);
    if (path.startsWith('/api/chapters/1')) return answer(CHAPTER);
    if (path.startsWith('/api/chapters/')) return notFound();
    if (path.startsWith('/api/front')) return answer(titleless ? { ...FRONT, title: null } : FRONT);
    if (path.startsWith('/api/cost')) return answer({ tokens: 0, tokensIn: 0, tokensOut: 0, steps: 0, usd: 0, unpriced: [] });
    if (path.startsWith('/api/me/decisions')) return answer({ items: [], open: [], share: 0 });
    if (path.startsWith('/api/authors'))
      return answer({ totalChars: 0, measuredAt: NOW, measured: 0, author: { label: 'Филипп Семиров', share: 1, chars: 0 }, contributors: [], total: 1 });
    // The feeds: an empty page, an empty register, an empty thread.
    return answer({ items: [], nextBefore: null });
  }) as unknown as typeof fetch;
}

function notFound(): Response {
  return { ok: false, status: 404, json: async () => ({ code: 'NOT_FOUND' }) } as unknown as Response;
}

/**
 * Every slot is in view at once, so a mounted `ChapterList` fetches at the first turn: the
 * absence of that fetch while gated is the page's own doing.
 */
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

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function gate(): HTMLElement | null {
  return document.querySelector<HTMLElement>('main.gate');
}

function accepted(): Request[] {
  return requests.filter((request) => request.path === '/api/age');
}

function proseRequests(): Request[] {
  return requests.filter((request) => request.path.startsWith('/api/chapters/'));
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((element) => element.textContent === label);
}

async function mount(): Promise<void> {
  await act(async () => {
    root?.render(<App />);
  });
  await settle();
}

beforeEach(() => {
  requests = [];
  ageFails = false;
  titleless = false;
  document.cookie = 'book_age=; max-age=0; path=/';
  window.history.replaceState({}, '', '/');
  vi.stubGlobal('fetch', fetchStub());
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  container = document.createElement('div');
  container.id = 'root';
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.cookie = 'book_age=; max-age=0; path=/';
  vi.unstubAllGlobals();
});

describe('the age gate (BOOK-225)', () => {
  it('stands where the chapters would, in the book’s column, and asks no prose', async () => {
    await mount();

    const page = gate();
    expect(page).not.toBeNull();
    // The rating, the book's own title, one honest sentence and the two doors: the words are
    // the requirement, so they are read here literally.
    expect(page?.querySelector('.kicker')?.textContent).toBe(AGE_LABEL);
    expect(page?.querySelector('.gate-title')?.textContent).toBe(TITLE);
    expect(page?.querySelector('.gate-line')?.textContent).toBe(AGE_GATE_LINE);
    expect(button(AGE_GATE_FORWARD)).toBeDefined();
    expect(page?.querySelector('a.gate-leave')?.getAttribute('href')).toBe('about:blank');
    expect(page?.querySelector('a.gate-leave')?.getAttribute('rel')).toBe('nofollow');
    expect(page?.querySelector('a.gate-leave')?.textContent).toBe(AGE_GATE_LEAVE);
    // A page, not a layer: nothing here is painted or floating, and no prose was asked for.
    expect(page?.tagName).toBe('MAIN');
    expect(page?.className).toBe('page gate');
    expect(proseRequests()).toEqual([]);
    // The book is still discoverable: the cover, the contents and the footer are on screen.
    expect(document.querySelector('#toc')).not.toBeNull();
    expect(document.querySelector('.colophon')).not.toBeNull();
    expect(document.body.textContent).toContain(FRONT.about ?? '');
    // ...and the prose is not.
    expect(document.body.textContent).not.toContain(PROSE);
  });

  it('answers with POST /api/age, then mounts the chapters and prints the prose', async () => {
    await mount();
    await act(async () => {
      button(AGE_GATE_FORWARD)?.click();
    });
    await settle();

    // One answer, one post: the acknowledgement is the server's, not a local flag.
    expect(accepted()).toEqual([{ path: '/api/age', method: 'POST' }]);
    expect(gate()).toBeNull();
    // The prose arrives only after the answer, and the reader sees it.
    expect(proseRequests().map((request) => request.path)).toContain('/api/chapters/1');
    expect(document.body.textContent).toContain(PROSE);
  });

  it('stays on the gate when the answer is refused, and claims nothing', async () => {
    ageFails = true;
    await mount();
    await act(async () => {
      button(AGE_GATE_FORWARD)?.click();
    });
    await settle();

    expect(accepted()).toHaveLength(1);
    // The gate is still the page, the prose is still unasked for, and the door can be tried again.
    expect(gate()).not.toBeNull();
    expect(proseRequests()).toEqual([]);
    expect(button(AGE_GATE_FORWARD)?.disabled).toBe(false);
  });

  it('keeps a reader who already answered past the gate, from the cookie alone', async () => {
    document.cookie = `book_age=${ageDateOf(new Date())}; path=/`;
    await mount();

    expect(gate()).toBeNull();
    expect(proseRequests().map((request) => request.path)).toContain('/api/chapters/1');
    expect(document.body.textContent).toContain(PROSE);
    // A reload never asks the question again.
    expect(accepted()).toEqual([]);
  });

  it('asks again when the device’s answer is spent, and asks for no prose meanwhile', async () => {
    // A year back is the bound the server reads too: the page must not be more permissive.
    document.cookie = 'book_age=2000-01-01; path=/';
    await mount();

    expect(gate()).not.toBeNull();
    expect(proseRequests()).toEqual([]);
  });

  it('prints no title it does not have', async () => {
    titleless = true;
    await mount();

    // The rating and the sentence still ask; a book with no name prints none.
    expect(gate()?.querySelector('.kicker')?.textContent).toBe(AGE_LABEL);
    expect(document.querySelector('.gate-title')).toBeNull();
    expect(document.querySelector('.gate-line')?.textContent).toBe(AGE_GATE_LINE);
  });

  it('keeps a first visit’s deep link until the answer, then lands on the chapter', async () => {
    // `useDeepLink` acts once per hash: consuming `#ch-1` on a gated page (where no chapter
    // exists) would lose it for good, so the landing waits for the answer.
    const scrolled: Array<{ top?: number }> = [];
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: (options: { top?: number }) => scrolled.push(options),
    });
    window.location.hash = '#ch-1';
    await mount();

    expect(gate()).not.toBeNull();
    expect(scrolled).toEqual([]);

    await act(async () => {
      button(AGE_GATE_FORWARD)?.click();
    });
    await settle();

    expect(gate()).toBeNull();
    expect(document.getElementById('ch-1')).not.toBeNull();
    expect(scrolled.length).toBeGreaterThan(0);
  });

  it('gives a gated reader no record page, even on a deep link to one', async () => {
    // The trail replaces the book page only for a reader past the gate: its past chapters are
    // prose, and the history's chapter route refuses them anyway. The predicate itself is
    // pinned in `recordMode.test.ts`; here the page proves the mode is not offered.
    expect(button('хроника')).toBeUndefined();
    window.history.replaceState({}, '', '/?change=chg_1');
    await mount();

    expect(gate()).not.toBeNull();
    expect(document.querySelector('.sled')).toBeNull();
  });
});
