// @vitest-environment jsdom
import {
  directionOf,
  partOf,
  TOTAL_CHAPTERS,
  ageDateOf,
  type CatalogEntry,
  type CommentDto,
  type FrontDto,
  type StateSnapshot,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { STATE_LINES } from './lib/marginalia.ts';

/**
 * BOOK-206 audit B1 — the live record moves without a reload.
 *
 * A reader's filing was accepted and then written; the page kept printing «в очереди на запись»
 * over text that already existed, because only `comment:added`/`comment:decision` refreshed the
 * filings. This mounts the real `App` on a stubbed socket and REST edge and drives the three
 * frames the page used to read for the change's own story only: `change:processing`,
 * `comment:decision` and `pass:stage` with `landed`. The assertions are the two a reader can
 * see — the row's word and the requests the page makes — never an internal call.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = '2026-10-29T12:00:00Z';

const catalog: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: partOf(n),
    title: null,
    rev: n === 8 ? 3 : 0,
    chars: n === 8 ? 900 : 0,
    blocks: n === 8 ? 6 : 0,
    written: n === 8,
    basis: n === 1 || n === TOTAL_CHAPTERS,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: directionOf(n),
  };
});

const STATE: StateSnapshot = {
  version: 1,
  at: NOW,
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: 'О чём эта книга.', rev: 1, updatedAt: NOW },
  chapters: { total: TOTAL_CHAPTERS, written: [8], empty: [], count: 1, totalChars: 900, basis: [1, TOTAL_CHAPTERS] },
  cursors: {} as StateSnapshot['cursors'],
  toc: catalog.map((row) => ({ part: row.part, n: row.n, title: null, written: row.written, rev: row.rev })),
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

/** The reader's own filing the writer has just taken: accepted, its change still pending. */
const ACCEPTED: CommentDto = {
  id: 'cmt_own',
  number: 1,
  chapter: 8,
  anchor: { blockId: 'ch08#aa11bb22', blockIndex: 2, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#6f9bb5',
  body: 'в комнате должен быть свет, но не от лампы',
  proposedText: null,
  interventionKind: 'testimony',
  status: 'accepted',
  reason: null,
  refusal: null,
  frame: 'untouched',
  premise: false,
  changeStatus: 'pending',
  attempt: null,
  createdAt: '2026-10-29T11:00:00Z',
  decidedAt: '2026-10-29T11:30:00Z',
  changeId: 'chg_1',
  applied: null,
};

/** The same filing after the close landed its text. */
const APPLIED: CommentDto = {
  ...ACCEPTED,
  status: 'applied',
  changeStatus: null,
  reason: 'правка внесена в главу 8',
  decidedAt: '2026-10-29T12:00:00Z',
  applied: { chapter: 8, rev: 4 },
};

let filing: CommentDto = ACCEPTED;
let requests: string[] = [];

function answer(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function fetchStub(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    if (path.startsWith('/api/state')) return answer(STATE);
    if (path.startsWith('/api/chapters/')) return answer(null);
    if (path.startsWith('/api/chapters')) return answer(catalog);
    if (path.startsWith('/api/front')) return answer(FRONT);
    if (path.startsWith('/api/me/decisions')) return answer({ items: [], open: [], share: 0 });
    if (path.startsWith('/api/changes')) return answer([]);
    if (path.startsWith('/api/authors'))
      return answer({
        totalChars: 0,
        measuredAt: NOW,
        measured: 0,
        author: { label: 'Филипп Семиров', share: 1, chars: 0 },
        contributors: [],
        total: 1,
      });
    // The thread and the chapter's feed: the one filing, in whatever state the server holds.
    if (path.startsWith('/api/comments')) return answer({ items: [filing], nextBefore: null });
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

/** A socket the test drives by hand: the app only ever `connect`s and awaits frames. */
class FakeSocket {
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

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

let sockets: FakeSocket[] = [];

function callsTo(prefix: string): number {
  return requests.filter((path) => path.startsWith(prefix)).length;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root?.render(<App />);
  });
  await settle();
}

async function receive(frame: unknown): Promise<void> {
  const socket = sockets.at(-1);
  expect(socket).toBeDefined();
  await act(async () => {
    socket?.receive(frame);
  });
  await settle();
}

/** The register row's own line: the word and the fact under it (`commentStatusLine`). */
function rowLine(): string {
  return document.querySelector('.comment-line')?.textContent ?? '';
}

beforeEach(() => {
  filing = ACCEPTED;
  requests = [];
  sockets = [];
  // BOOK-225 — this page is read by a reader who already answered the rating: the gate is not
  // what this file is about, and the chapter flow must mount for the record to move at all.
  document.cookie = `book_age=${ageDateOf(new Date())}; path=/`;
  vi.stubGlobal('fetch', fetchStub());
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('IntersectionObserver', IdleObserver);
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

describe('the live record (BOOK-206 B1)', () => {
  it('moves the accepted row to «внесено» on the landing frame, with no reload', async () => {
    await mount();
    expect(rowLine()).toContain(STATE_LINES.accepted);

    // The server's durable row already says applied when the frame asks the page to re-read.
    filing = APPLIED;
    await receive({
      v: 1,
      type: 'comment:decision',
      seq: 12,
      ts: NOW,
      data: {
        id: 'cmt_own',
        chapter: 8,
        status: 'applied',
        reason: 'правка внесена в главу 8',
        decidedAt: NOW,
        changeId: 'chg_1',
        applied: { chapter: 8, rev: 4 },
      },
    });

    expect(rowLine()).toContain('внесено');
    expect(rowLine()).not.toContain('в очереди');
    // The same page: no remount, no second mount's boot requests.
    expect(callsTo('/api/state')).toBe(1);
  });

  it('re-reads the filing’s chapter when the writer claims the change', async () => {
    await mount();
    const thread = callsTo('/api/comments?limit=20');
    const chapterFeed = callsTo('/api/comments?chapter=8');

    await receive({
      v: 1,
      type: 'change:processing',
      seq: 13,
      ts: NOW,
      data: { id: 'chg_1', chapter: 8, startedAt: NOW, attempt: 1, relevance: null },
    });

    expect(callsTo('/api/comments?limit=20')).toBe(thread + 1);
    expect(callsTo('/api/comments?chapter=8')).toBe(chapterFeed + 1);
  });

  it('a landed pass re-reads the chapter’s filings and the text’s own edition', async () => {
    await mount();
    const catalogReads = callsTo('/api/chapters');
    const frontReads = callsTo('/api/front');
    const chapterFeed = callsTo('/api/comments?chapter=8');

    await receive({
      v: 1,
      type: 'pass:stage',
      seq: 14,
      ts: NOW,
      data: {
        passId: 'pass_1',
        chapter: 8,
        stageSeq: 4,
        stage: 'landed',
        at: Date.parse(NOW),
        actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
        changeId: 'chg_1',
        summary: 'глава 8 переписана',
        span: null,
        tokens: null,
        costUsd: null,
      },
    });

    expect(callsTo('/api/comments?chapter=8')).toBe(chapterFeed + 1);
    // The catalog's `rev` is what makes the slot fetch the prose again; the front read is the
    // edition line — the same pair a landing already takes, on its own one-second debounce.
    expect(callsTo('/api/chapters')).toBe(catalogReads + 1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    expect(callsTo('/api/front')).toBe(frontReads + 1);
  });
});
