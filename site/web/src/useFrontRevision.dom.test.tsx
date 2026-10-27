// @vitest-environment jsdom
import type { FrontDto } from '@book/shared';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BookData } from './lib/bookState.ts';
import { useFrontRevision } from './useFrontRevision.ts';

/**
 * BOOK-60 / BOOK-DOC-41 §6 — the end matter's edition number is re-read after a text frame,
 * without turning a cascade's burst of frames into a burst of requests.
 *
 * The contract: a frame waits for a one-second trailing window (three frames collapse into
 * one read), only one request is ever in flight and a frame that arrives mid-read gets exactly
 * one follow-up, a failed read keeps the number the page already has, and unmounting clears
 * the pending timer. Real 1 s waits would make the suite slow and flaky, so time is faked.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let note: (() => void) | null = null;
let revision: number | null = null;

function book(held?: number): BookData {
  return {
    state: {} as BookData['state'],
    catalog: [],
    front: {
      title: null,
      about: null,
      rev: 0,
      toc: [],
      imprint: { author: 'А', copyright: '© А' },
      authors: { count: 0, measuredAt: '' },
      ...(held === undefined ? {} : { revision: held }),
    },
  };
}

/** The hook's own answer, rendered: the real `setData` path, not a copy of the mock. */
function Probe() {
  const [data, setData] = useState<BookData | null>(book());
  note = useFrontRevision(setData);
  revision = data?.front.revision ?? null;
  return <span>{revision ?? '—'}</span>;
}

const front = (value: number): Response =>
  ({ ok: true, status: 200, json: async () => ({ revision: value }) as FrontDto }) as unknown as Response;
const down = (): Response => ({ ok: false, status: 503, statusText: 'down', json: async () => ({}) }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  note = null;
  revision = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(): Promise<void> {
  await act(async () => {
    root?.render(<Probe />);
  });
}

async function frame(): Promise<void> {
  await act(async () => {
    note?.();
  });
}

/** Advance fake time and let the request's promise chain land in one commit. */
async function tick(ms = 1_000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useFrontRevision (BOOK-60)', () => {
  it('collapses three frames in a row into one read after the one-second window', async () => {
    const fetchMock = vi.fn(async (_path: string) => front(7));
    vi.stubGlobal('fetch', fetchMock);
    await render();

    await frame();
    await frame();
    await frame();
    // Nothing is asked while the window is still open.
    expect(fetchMock).not.toHaveBeenCalled();
    await tick(999);
    expect(fetchMock).not.toHaveBeenCalled();

    await tick(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/front');
    expect(revision).toBe(7);
  });

  it('keeps one request in flight and makes exactly one follow-up for a mid-read frame', async () => {
    let release: (value: Response) => void = () => undefined;
    const firstRead = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const response = fetchMock.mock.calls.length === 1 ? await firstRead : front(9);
      active -= 1;
      return response;
    });
    vi.stubGlobal('fetch', fetchMock);
    await render();

    await frame();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The read is still open: this frame may not start a second one, only mark the follow-up.
    await frame();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(front(7));
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(revision).toBe(9);
  });

  it('keeps the old number when /api/front fails, and the next frame asks again', async () => {
    let mode: 'ok' | 'down' = 'ok';
    let value = 7;
    const fetchMock = vi.fn(async () => (mode === 'ok' ? front(value) : down()));
    vi.stubGlobal('fetch', fetchMock);
    await render();

    await frame();
    await tick();
    expect(revision).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A hiccup is not a new edition: the line keeps the number it had.
    mode = 'down';
    await frame();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(revision).toBe(7);

    // The next frame retries and the fresh number replaces the old one.
    mode = 'ok';
    value = 9;
    await frame();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(revision).toBe(9);
  });

  it('clears the pending timer on unmount', async () => {
    const fetchMock = vi.fn(async () => front(7));
    vi.stubGlobal('fetch', fetchMock);
    await render();

    await frame();
    await act(async () => root?.unmount());
    root = null;
    await tick(5_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
