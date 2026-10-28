// @vitest-environment jsdom
import type { HistoryRecordDto, HistoryTimelineDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Chronicle } from './Chronicle.tsx';

/**
 * BOOK-DOC-43 §4, §6, §7, §10 (BOOK-66) — the chronicle's own wait, under a clock.
 *
 * The thresholds (150 ms, 2 000 ms) and the settle need timers, so they live here: nothing
 * below the rail claims a fact it does not hold, the status and the form share one slot, a
 * failure replaces the wait with its block, and a retry is a wait again from its first frame.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function record(hseq: number, chapter: number): HistoryRecordDto {
  return {
    id: `chg_${chapter}`,
    hseq,
    at: '2026-10-26T10:00:00Z',
    seq: chapter,
    chapter,
    chapterTitle: null,
    premise: false,
    premiseLanded: false,
    alias: 'Филипп',
    cause: 'reader',
    status: 'done',
    outcome: 'applied',
    reason: null,
    changeId: `chg_${chapter}`,
    recordHref: `#правка-chg_${chapter}`,
    span: null,
  };
}

function page(hseqs: readonly number[], lastHseq: number): HistoryTimelineDto {
  const items = hseqs.map((hseq, index) => record(hseq, index + 1));
  return {
    lastHseq,
    lastAt: items[0]?.at ?? null,
    firstAt: items.at(-1)?.at ?? null,
    at: '2026-10-26T10:00:00Z',
    items,
    nextBefore: null,
  };
}

/** `readJson` needs only `ok` and `json()` on the happy path; no jsdom `fetch`/`Response`. */
function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance the fake clock and let the promise chain settle inside one act(). */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let root: Root | null = null;
let container: HTMLDivElement;

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Chronicle catalog={[]} frontRev={1} tick={0} started live />);
  });
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    mount();
    const section = container.querySelector('section.chronicle');
    expect(section?.getAttribute('aria-busy')).toBe('true');

    // 149 ms — quiet: no form, no sentence, and the §10 false fact is not printed.
    await advance(149);
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('записи читаются');
    expect(container.textContent).not.toContain('пока ничего не записано');
    expect(container.querySelector('ol.chr-timeline')).toBeNull();

    // 150 ms — the status in the `.chr-empty` slot, the form of one day label + three rows.
    await advance(1);
    const status = container.querySelector('p.chr-empty');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
    expect(status?.textContent).toBe('записи читаются');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.skel-chronicle')?.getAttribute('data-rows')).toBe('3');
    expect(container.querySelectorAll('.skel-chronicle .skel-row')).toHaveLength(3);

    // 2 000 ms — one plain sentence, still one status.
    await advance(1_850);
    expect(container.querySelector('p.chr-empty')?.textContent).toBe(
      'записи идут дольше обычного · хроника появится здесь же',
    );

    // Settle: rows in the same commit that removes the form; the busy claim is removed.
    await act(async () => {
      settle?.(answer(page([2, 5], 5)));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelectorAll('.chr-row')).toHaveLength(2);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(section?.hasAttribute('aria-busy')).toBe(false);
  });

  it('replaces the wait with the failure block: no form, no status, no absence', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    mount();
    await flush();

    expect(container.textContent).toContain('хроника не прочиталась');
    expect(container.textContent).toContain('повторить');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('пока ничего не записано');
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('starts a retry as a wait again: no failure line, busy at once, the form back at 150 ms', async () => {
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
    mount();
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
    await advance(149);
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();

    await advance(1);
    expect(container.querySelector('.skel-chronicle')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('записи читаются');

    await act(async () => {
      hang?.(answer(page([2, 5], 5)));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelectorAll('.chr-row')).toHaveLength(2);
  });

  it('prints «пока ничего не записано» only for an answer with no events', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(page([], 0))));
    mount();
    await flush();

    expect(container.textContent).toContain('пока ничего не записано');
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-busy')).toBe(false);
  });
});
