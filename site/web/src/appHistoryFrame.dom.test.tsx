// @vitest-environment jsdom
import {
  directionOf,
  partOf,
  TOTAL_CHAPTERS,
  ageDateOf,
  type CatalogEntry,
  type FrontDto,
  type HistoryTimelineDto,
  type StateSnapshot,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';

/**
 * BOOK-102 — a client that receives the bare tick still refreshes.
 *
 * The socket's `history:event` frame is `{ hseq, at }` and nothing else, so the page has no
 * sentence to print: its whole reaction is to re-read the record. This mounts the real `App`
 * on a stubbed socket and a stubbed REST edge, switches to «хроника», and counts the record's
 * requests: a bare frame must produce one more `GET /api/history/timeline`.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = '2026-10-27T12:00:00Z';

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

/** One reader change, so the chronicle and its switch exist (`started` and `live`). */
const STATE: StateSnapshot = {
  version: 1,
  at: NOW,
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: 'О чём эта книга.', rev: 1, updatedAt: NOW },
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
  history: { live: true, readerChanges: 1, started: true },
};

const FRONT: FrontDto = {
  title: 'Бланк',
  about: 'О чём эта книга.',
  rev: 1,
  toc: STATE.toc,
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 1, measuredAt: NOW },
  revision: 1,
  exportBytes: 1024,
};

const TIMELINE: HistoryTimelineDto = {
  lastHseq: 10,
  lastAt: NOW,
  firstAt: NOW,
  at: NOW,
  nextBefore: null,
  items: [
    {
      id: 'chg_1',
      hseq: 10,
      at: NOW,
      seq: 1,
      chapter: 8,
      chapterTitle: null,
      premise: false,
      premiseLanded: false,
      alias: 'Аня',
      cause: 'reader',
      status: 'done',
      outcome: 'applied',
      reason: null,
      changeId: 'chg_1',
      recordHref: '?change=chg_1',
      span: null,
    },
  ],
};

type Request = { path: string };

let requests: Request[] = [];

function answer(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function fetchStub(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push({ path });
    if (path.startsWith('/api/state')) return answer(STATE);
    if (path.startsWith('/api/chapters')) return answer(catalog);
    if (path.startsWith('/api/front')) return answer(FRONT);
    if (path.startsWith('/api/history/timeline')) return answer(TIMELINE);
    if (path.startsWith('/api/cost')) return answer({ tokens: 0, tokensIn: 0, tokensOut: 0, steps: 0, usd: 0, unpriced: [] });
    if (path.startsWith('/api/me/decisions')) return answer({ items: [], open: [], share: 0 });
    if (path.startsWith('/api/authors'))
      return answer({
        totalChars: 0,
        measuredAt: NOW,
        measured: 0,
        author: { label: 'Филипп Семиров', share: 1, chars: 0 },
        contributors: [],
        total: 1,
      });
    // The feeds: an empty page, an empty register, an empty thread.
    return answer({ items: [], nextBefore: null });
  }) as unknown as typeof fetch;
}

/** A chapter never comes into view here: the page is mounted for its socket, not its prose. */
class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

/** A socket the test drives by hand: the app only ever `connect`s and awaits frames. */class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server's side: one envelope, as `ws/hub.ts` would write it. */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[] = [];

function framesFor(path: string): number {
  return requests.filter((request) => request.path.startsWith(path)).length;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  // Three turns: the mount's fetches, their state writes, and the effects those writes run.
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  requests = [];
  sockets = [];
  // BOOK-225 — a reader who already answered the rating: the reading page mounts its chapter
  // flow (and the «книга · хроника» switch) only after that answer, which is another file's
  // subject (`ageGate.dom.test.tsx`).
  document.cookie = `book_age=${ageDateOf(new Date())}; path=/`;
  vi.stubGlobal('fetch', fetchStub());
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('IntersectionObserver', IdleObserver);
  // No motion preferences in jsdom; the reduced-motion branch then reads as "full motion".
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
  vi.unstubAllGlobals();
});

describe('the client’s reaction to a bare history:event frame (BOOK-102)', () => {
  it('re-reads the record it prints when `{ hseq, at }` arrives, and does not need a summary', async () => {
    await act(async () => {
      root?.render(<App />);
    });
    await settle();

    // The switch exists because the fixture's log holds a reader change.
    const chronicle = [...document.querySelectorAll('button')].find((button) => button.textContent === 'хроника');
    expect(chronicle).toBeDefined();
    await act(async () => {
      chronicle?.click();
    });
    await settle();

    const before = framesFor('/api/history/timeline');
    expect(before).toBeGreaterThan(0);

    const socket = sockets.at(-1);
    expect(socket).toBeDefined();
    await act(async () => {
      socket?.receive({ v: 1, type: 'history:event', seq: 1, ts: NOW, data: { hseq: 11, at: NOW } });
    });
    await settle();

    // The tick is the whole message, and it is enough: the record is fetched again.
    expect(framesFor('/api/history/timeline')).toBe(before + 1);
  });

  it('ignores a tick at the log’s zero: nothing moved, so nothing is re-read', async () => {
    await act(async () => {
      root?.render(<App />);
    });
    await settle();

    const chronicle = [...document.querySelectorAll('button')].find((button) => button.textContent === 'хроника');
    await act(async () => {
      chronicle?.click();
    });
    await settle();
    const before = framesFor('/api/history/timeline');

    const socket = sockets.at(-1);
    await act(async () => {
      socket?.receive({ v: 1, type: 'history:event', seq: 1, ts: NOW, data: { hseq: 0, at: NOW } });
    });
    await settle();

    expect(framesFor('/api/history/timeline')).toBe(before);
  });
});
