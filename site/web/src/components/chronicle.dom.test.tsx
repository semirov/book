// @vitest-environment jsdom
import type { HistoryEventDto, HistoryTimelineDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Chronicle } from './Chronicle.tsx';

/**
 * BOOK-30 — the scrubber's ticks are placed by a live CSSOM write.
 *
 * A dead ref would leave every `<i>` at `left:auto` and the SSR test would still pass.
 * This mounts the chronicle, lets it read a stub timeline, and checks the offsets the
 * browser receives — including the case where the event set shrinks.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function event(hseq: number, chapter: number): HistoryEventDto {
  return {
    hseq,
    at: '2026-10-26T10:00:00Z',
    kind: 'chapter.created',
    chapter,
    isFront: false,
    rev: 1,
    changeId: null,
    cascadeId: null,
    stepId: null,
    author: { kind: 'author', identityId: null, label: 'Филипп' },
    summary: `глава ${chapter} создана`,
  };
}

function page(hseqs: readonly number[], lastHseq: number): HistoryTimelineDto {
  return {
    lastHseq,
    at: '2026-10-26T10:00:00Z',
    items: hseqs.map((hseq, index) => event(hseq, index + 1)),
    nextBefore: null,
  };
}

/** `readJson` needs only `ok` and `json()` on the happy path; no jsdom `fetch`/`Response`. */
function answer(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the chronicle ticks under a browser', () => {
  it('places every tick from its event, and shrinks the set when events shrink', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer(page([2, 5, 10], 10)))
      .mockResolvedValueOnce(answer(page([3, 10], 10)));
    vi.stubGlobal('fetch', fetchMock);

    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = (tick: number) => (
      <Chronicle catalog={[]} frontRev={1} tick={tick} changes={[]} onOpenChange={() => undefined} />
    );

    await act(async () => root?.render(render(0)));
    await flush();

    const ticks = (): string[] =>
      [...container.querySelectorAll<HTMLElement>('.scrub-ticks i')].map((tick) => tick.style.left);
    expect(ticks()).toEqual(['20%', '50%', '100%']);

    // A new tick on the feed refetches a smaller page: stale ticks must not survive.
    await act(async () => root?.render(render(1)));
    await flush();

    expect(container.querySelectorAll('.scrub-ticks i')).toHaveLength(2);
    expect(ticks()).toEqual(['30%', '100%']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
