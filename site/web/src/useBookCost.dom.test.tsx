// @vitest-environment jsdom
import type { BookCostDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBookCost } from './useBookCost.ts';

/**
 * BOOK-114 — the footer's outlay is read once per book state, and never replaced by a failure.
 *
 * The line itself is pinned in `lib/bookCost.test.ts` and the colophon's own tests; this file
 * is the hook's contract: no request before the page has read the book, a request when the
 * state version moves and not again for the same one, and a failed read that keeps the last
 * measured total instead of blanking the footer.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The value the probe last rendered: the hook's own answer, not a copy of the mock. */
let seen: BookCostDto | null = null;

function Probe({ version }: { version: number | null }) {
  seen = useBookCost(version);
  return <span>{seen === null ? 'нет' : `${seen.tokens}`}</span>;
}

function cost(tokens: number): BookCostDto {
  return { tokens, tokensIn: tokens, tokensOut: 0, steps: 1, usd: 0.15, unpriced: [] };
}

const ok = (tokens: number): Response => ({ ok: true, status: 200, json: async () => cost(tokens) }) as Response;
const down = (): Response => ({ ok: false, status: 503, statusText: 'down', json: async () => ({}) }) as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  seen = null;
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
});

async function render(version: number | null): Promise<void> {
  await act(async () => {
    root?.render(<Probe version={version} />);
  });
}

/** Let the request's promise and React's update land in one commit. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useBookCost', () => {
  it('asks for nothing before the page has read the book', async () => {
    const fetchMock = vi.fn(async () => ok(10));
    vi.stubGlobal('fetch', fetchMock);

    await render(null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seen).toBeNull();
  });

  it('reads once per book state, and keeps the value for the same version', async () => {
    let tokens = 10;
    // The path is a parameter so the assertion can name what the hook asked for.
    const fetchMock = vi.fn(async (_path: string) => ok(tokens));
    vi.stubGlobal('fetch', fetchMock);

    await render(1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/cost');
    expect(seen).toEqual(cost(10));

    // The same version is the same book: a re-render reads nothing.
    await render(1);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    tokens = 20;
    await render(2);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(cost(20));
  });

  it('keeps the last measured total when the read fails', async () => {
    const fetchMock = vi.fn(async () => ok(10));
    vi.stubGlobal('fetch', fetchMock);
    await render(1);
    await flush();
    expect(seen).toEqual(cost(10));

    // A hiccup is not a total of zero: the footer keeps the number it measured.
    fetchMock.mockImplementation(async () => down());
    await render(2);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(cost(10));

    // The next version reads it again, and the new number replaces the old one.
    fetchMock.mockImplementation(async () => ok(30));
    await render(3);
    await flush();
    expect(seen).toEqual(cost(30));
  });
});
