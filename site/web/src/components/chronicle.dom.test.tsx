// @vitest-environment jsdom
import type { BookAtDto, HistoryEventDto, HistoryTimelineDto } from '@book/shared';
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
 *
 * BOOK-DOC-43 §4, §6, §7, §10 (BOOK-66) — the same mount proves the timeline's wait and the
 * moment's: the thresholds need a clock, so they live here; the failure of `getHistoryAt`
 * must leave «момент читается…» and offer the retry that re-requests the same hseq.
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

/** The book as it was at hseq 2: enough for the past to have a title. */
const AT: BookAtDto = {
  hseq: 2,
  at: '2026-10-26T10:00:00Z',
  front: { rev: 1, title: 'Книга', about: null },
  chapters: [],
  lastHseq: 5,
};

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount(): { container: HTMLDivElement; render: (tick: number) => void } {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const render = (tick: number): void => {
    root?.render(<Chronicle catalog={[]} frontRev={1} tick={tick} changes={[]} onOpenChange={() => undefined} />);
  };
  return { container, render };
}

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

describe('the chronicle while the timeline is in flight (BOOK-DOC-43)', () => {
  it('shows nothing before 150 ms, the sentence and the form at 150, the slow line at 2 000, rows on settle', async () => {
    let settle: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => {
        settle = resolve;
      })),
    );
    vi.useFakeTimers();
    const { container, render } = mount();

    await act(async () => render(0));
    const section = container.querySelector('section.chronicle');
    expect(section?.getAttribute('aria-busy')).toBe('true');

    // 149 ms — quiet: no form, no sentence, and the §10 false fact is not printed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('записи читаются');
    expect(container.textContent).not.toContain('пока ничего не записано');
    expect(container.querySelector('ol.chr-timeline')).toBeNull();

    // 150 ms — the status in the `.chr-empty` slot, the form of one day label + three rows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const status = container.querySelector('p.chr-empty');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(status?.textContent).toBe('записи читаются');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.skel-chronicle')?.getAttribute('data-rows')).toBe('3');
    expect(container.querySelectorAll('.skel-chronicle .skel-row')).toHaveLength(3);

    // 2 000 ms — one plain sentence, still one status.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_850);
    });
    expect(container.querySelector('p.chr-empty')?.textContent).toBe(
      'записи идут дольше обычного · хроника появится здесь же',
    );

    // Settle: rows in the same commit that removes the form; the busy claim is removed.
    await act(async () => settle?.(answer(page([2, 5], 5))));
    await flush();
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelectorAll('.chr-row')).toHaveLength(2);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(section?.hasAttribute('aria-busy')).toBe(false);
  });

  it('replaces the wait with the failure block: no form, no status, no absence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { container, render } = mount();

    await act(async () => render(0));
    await flush();

    expect(container.textContent).toContain('хроника не прочиталась');
    expect(container.textContent).toContain('повторить');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('пока ничего не записано');
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('starts a retry as a wait again: no failure line, busy at once, the form back at 150 ms', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let hang: ((value: Response) => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('offline'));
        return new Promise<Response>((resolve) => {
          hang = resolve;
        });
      }),
    );
    const { container, render } = mount();

    await act(async () => render(0));
    await flush();
    expect(container.textContent).toContain('хроника не прочиталась');

    const retry = container.querySelector<HTMLButtonElement>('.state-line button');
    expect(retry?.textContent).toBe('повторить');
    await act(async () => retry?.click());
    expect(calls).toBe(2);

    // The failure goes when the request starts, not when it answers (§10): the section is busy
    // again and, before 150 ms, still prints nothing.
    expect(container.textContent).not.toContain('хроника не прочиталась');
    expect(container.querySelector('section.chronicle')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(149);
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('.skel-chronicle')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('записи читаются');

    await act(async () => hang?.(answer(page([2, 5], 5))));
    await flush();
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelectorAll('.chr-row')).toHaveLength(2);
  });

  it('prints «пока ничего не записано» only for an answer with no events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(page([], 0))));
    const { container, render } = mount();

    await act(async () => render(0));
    await flush();

    expect(container.textContent).toContain('пока ничего не записано');
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('the moment’s read (BOOK-DOC-43 §10)', () => {
  it('leaves the loading line on failure, and retries the same hseq', async () => {
    let atCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes('/api/history/at/')) {
        atCalls += 1;
        return atCalls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(answer(AT));
      }
      return Promise.resolve(answer(page([2, 5], 5)));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container, render } = mount();

    await act(async () => render(0));
    await flush();

    const row = container.querySelector<HTMLButtonElement>('.chr-row-main');
    expect(row).not.toBeNull();
    await act(async () => row?.click());
    await flush();

    // The wait is over: no «момент читается…», one failure line, one retry.
    expect(container.textContent).toContain('момент не прочитался');
    expect(container.textContent).not.toContain('момент читается');
    const retry = container.querySelector<HTMLButtonElement>('.past .state-line button');
    expect(retry?.textContent).toBe('повторить');

    await act(async () => retry?.click());
    await flush();

    const atUrls = fetchMock.mock.calls.map((call) => String(call[0])).filter((path) => path.includes('/api/history/at/'));
    expect(atUrls).toEqual(['/api/history/at/2', '/api/history/at/2']);
    expect(container.textContent).not.toContain('момент не прочитался');
    expect(container.querySelector('.past-title')?.textContent).toBe('Книга');
  });
});
