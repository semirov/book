// @vitest-environment jsdom
import type { ChangeDto, ChapterDto, CommentDto, PassStageEvent } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePassRecord } from '../lib/usePassRecord.ts';
import { MIDDOT } from '../lib/format.ts';
import { PassRecord } from './PassRecord.tsx';

/**
 * BOOK-166 — the record's lifecycle under a browser: the heading lands first, the body lands
 * second, and the reader is moved once.
 *
 * The page is mounted at its final height: the heading's node exists from the first paint and
 * its height is reserved, so the body arriving below it cannot move it. The landing scroll runs
 * once per record id (`scrollTo`), and 600 ms of re-renders and timers add neither a second
 * scroll nor a second heading.
 *
 * The hash is the only switch: `#проход-<changeId>` reads the change, `#проход-<chapter>-<passId>`
 * reads the pass; a hash change cancels the read in flight and starts one for the new key.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const T0 = Date.parse('2026-10-25T08:18:00Z');
const T1 = Date.parse('2026-10-25T08:19:00Z');

const STAGES: PassStageEvent[] = [
  {
    passId: 'stp_1',
    chapter: 7,
    stageSeq: 1,
    stage: 'read',
    at: T0,
    actor: { process: 'writer', model: null },
    changeId: 'chg_1',
    summary: 'глава 7 читается',
    span: null,
    tokens: null,
    costUsd: null,
  },
  {
    passId: 'stp_1',
    chapter: 7,
    stageSeq: 2,
    stage: 'landed',
    at: T1,
    actor: { process: 'writer', model: null },
    changeId: 'chg_1',
    summary: 'глава 7 вписана',
    span: [{ blockId: null, before: 'старый фонарь', after: 'новый фонарь', truncated: false }],
    tokens: { in: 100_000, out: 26_099 },
    costUsd: 0.08,
  },
];

const CHAPTER: ChapterDto = {
  n: 7,
  title: 'Дорога',
  rev: 2,
  chars: 120,
  basis: false,
  writtenAt: '2026-10-25T08:00:00Z',
  updatedAt: '2026-10-25T08:00:00Z',
  blocks: Array.from({ length: 12 }, (_, index) => ({
    id: `ch07#${String(index)}`,
    i: index,
    text: index === 11 ? 'новый фонарь' : `абзац ${String(index + 1)}`,
    hash: 'h',
  })),
};

const CHANGE = {
  id: 'chg_1',
  chapter: 7,
  status: 'done',
  outcome: 'applied',
  startedAt: '2026-10-25T08:18:00Z',
  enqueuedAt: '2026-10-25T08:15:00Z',
  decidedAt: '2026-10-25T08:20:56Z',
  source: { commentId: 'cmt_1', author: 'Аня' },
  cost: { model: null, tokensIn: 100_000, tokensOut: 26_099, rub: null },
} as unknown as ChangeDto;

const COMMENT = { anchor: { blockIndex: 11 } } as unknown as CommentDto;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
/** A gate the first test holds closed, so the heading-only paint can be observed. */
let gate: Promise<void> | null = null;

function route(input: RequestInfo | URL): Response {
  const url = String(input);
  if (url.startsWith('/api/chapters/7/stages')) return json({ stages: STAGES });
  if (url.startsWith('/api/chapters/7')) return json(CHAPTER);
  if (url.startsWith('/api/changes/chg_1')) return json(CHANGE);
  if (url.startsWith('/api/comments/cmt_1')) return json(COMMENT);
  return json({ code: 'NOT_FOUND', message: 'no such row' }, 404);
}

function Probe() {
  const record = usePassRecord();
  // The mode, as `App` mounts it: no record hash, no record page.
  if (record.phase === 'idle') return null;
  return <PassRecord key={record.hash} state={record} />;
}

let root: Root | null = null;
let container: HTMLDivElement;
let scrollTo: ReturnType<typeof vi.fn>;

const rect = { top: 120, bottom: 140, left: 0, right: 0, width: 0, height: 20, x: 0, y: 120, toJSON: () => ({}) } as DOMRect;
const zero = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

beforeEach(() => {
  vi.useFakeTimers();
  window.location.hash = '#проход-chg_1';
  gate = null;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (gate !== null) await gate;
    return route(input);
  });
  vi.stubGlobal('fetch', fetchMock);
  scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  // jsdom has no layout: the heading is one box at `top: 120`, everything else is empty.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('pr-head') ? rect : zero;
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.location.hash = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Flush the promise chain of the one read (change → stages + chapter + filing). */
async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function mount(): Promise<HTMLElement> {
  await act(async () => {
    root?.render(<Probe />);
  });
  return container;
}

describe('the record mounts at its final height', () => {
  it('renders the heading first, the body when the answer lands, and scrolls exactly once', async () => {
    let open = (): void => undefined;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await mount();
    const heading = container.querySelector('.pr-head') as HTMLHeadingElement;
    // The node is there before the answer, with its line reserved (the sheet's `min-height`).
    expect(heading).not.toBeNull();
    expect(heading.textContent).toBe('');
    expect(container.querySelector('.pass-record')?.getAttribute('aria-busy')).toBe('true');
    expect(scrollTo).not.toHaveBeenCalled();

    gate = null;
    open();
    await settle();
    expect(heading.textContent).toBe(`писалась${MIDDOT}глава 7${MIDDOT}11:18`);
    // The same node, one line: the body arrived below it and nothing above it moved.
    expect(container.querySelector('.pr-head')).toBe(heading);
    expect(container.querySelector('.pass-record')?.getAttribute('aria-busy')).toBeNull();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // top(#pr-head) = 120, less the head's 64.
    expect(scrollTo).toHaveBeenCalledWith({ top: 56, behavior: 'auto' });

    const top = heading.getBoundingClientRect().top;
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(container.querySelector('.pr-head')).toBe(heading);
    expect(heading.getBoundingClientRect().top).toBe(top);
    // A re-render of the same record is not a second landing.
    await act(async () => {
      root?.render(<Probe />);
    });
    await settle();
    expect(container.querySelector('.pr-head')).toBe(heading);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('reads the change once, the chapter and the filing beside its stages', async () => {
    await mount();
    await settle();
    const asked = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(asked.filter((url) => url.startsWith('/api/changes/chg_1'))).toHaveLength(1);
    expect(asked.filter((url) => url.startsWith('/api/chapters/7/stages'))).toHaveLength(1);
    expect(asked.filter((url) => url.startsWith('/api/chapters/7') && !url.includes('/stages'))).toHaveLength(1);
    expect(asked.filter((url) => url.startsWith('/api/comments/cmt_1'))).toHaveLength(1);
  });
});

describe('a hash change is a new record', () => {
  it('reads the bare pass by its chapter and id, and lands it once', async () => {
    await mount();
    await settle();
    expect(scrollTo).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.location.hash = '#проход-7-stp_1';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/chapters/7/stages?pass=stp_1'))).toBe(true);
    expect(container.querySelector('.pr-head')?.textContent).toBe(`писалась${MIDDOT}глава 7${MIDDOT}11:18`);
    // One landing per id: the second launch moved the page once more, never twice.
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('leaves the mode when the hash is no longer a record', async () => {
    await mount();
    await settle();
    await act(async () => {
      window.location.hash = '#ch-7';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle();
    expect(container.querySelector('.pass-record')).toBeNull();
    // The landing of the record that was open stays the only scroll it caused.
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe('a record nobody wrote', () => {
  it('says «пока не писалась» instead of inventing a pass', async () => {
    window.location.hash = '#проход-chg_gone';
    await mount();
    await settle();
    expect(container.querySelector('.pr-head')?.textContent).toBe('пока не писалась');
    expect(container.querySelector('.pr-jump')?.getAttribute('href')).toBe('#toc');
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe('the read’s degenerate paths', () => {
  it('reads a change with no filing and asks for no comment', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/chapters/7/stages')) return json({ stages: STAGES });
      if (url.startsWith('/api/chapters/7')) return json(CHAPTER);
      if (url.startsWith('/api/changes/chg_1')) return json({ ...CHANGE, source: { commentId: null, author: null } });
      return json({}, 404);
    });
    await mount();
    await settle();
    const asked = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(asked.some((url) => url.startsWith('/api/comments/'))).toBe(false);
    // Without a filing the paragraph is not invented; the landed span's own words name it.
    expect(container.querySelector('.pr-head')?.textContent).toBe(`писалась${MIDDOT}глава 7${MIDDOT}11:18`);
    expect(container.textContent).toContain('абзац 12');
  });

  it('treats a failed stages read as no stage, never as a broken page', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/chapters/7/stages')) throw new Error('offline');
      if (url.startsWith('/api/chapters/7')) return json(CHAPTER);
      return json({}, 404);
    });
    window.location.hash = '#проход-7-stp_1';
    await mount();
    await settle();
    expect(container.querySelector('.pr-head')?.textContent).toBe('пока не писалась');
    expect(container.querySelector('.pr-jump')?.getAttribute('href')).toBe('#toc');
  });

  it('keeps the stages when the chapter does not answer', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/chapters/7/stages')) return json({ stages: STAGES });
      if (url.startsWith('/api/chapters/7')) throw new Error('offline');
      return json({}, 404);
    });
    window.location.hash = '#проход-7-stp_1';
    await mount();
    await settle();
    expect(container.querySelector('.pr-head')?.textContent).toBe(`писалась${MIDDOT}глава 7${MIDDOT}11:18`);
    expect(container.querySelector('.pr-place')).toBeNull();
    expect(container.querySelector('.pr-jump')?.textContent).toBe('к главе 7 →');
  });

  it('treats a failed change read as an unknown id', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('offline');
    });
    await mount();
    await settle();
    expect(container.querySelector('.pr-head')?.textContent).toBe('пока не писалась');
    expect(container.querySelector('.pr-jump')?.getAttribute('href')).toBe('#toc');
  });
});
