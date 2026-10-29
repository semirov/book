// @vitest-environment jsdom
import type { BookAtDto, HistoryRecordDto, HistoryTimelineDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NBSP } from '../lib/format.ts';
import { Chronicle } from './Chronicle.tsx';

/**
 * BOOK-DOC-50 §6, §7 — the moment under a browser.
 *
 * A drag moves the readout in the same frame and asks nothing; idle asks once; a release asks
 * at once; an answer that is not for the thumb cannot paint; a failure keeps the date, the
 * thumb and a retry for that same hseq. And there is not one unlabelled mark in the DOM.
 *
 * BOOK-65 — the list is the record, so a row is one change and the moment moves only through
 * the control: clicking an entry opens its card, it never scrubs.
 *
 * BOOK-DOC-43 §4, §6, §7, §10 (BOOK-66) — the same mount proves the timeline's wait: the
 * thresholds need a clock, so they live here; a failure keeps its block and «повторить»
 * re-reads it, and the failure of `getHistoryAt` keeps the retry for the same hseq.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const MID = `${NBSP}·${NBSP}`;

function record(hseq: number, at: string, seq: number): HistoryRecordDto {
  const id = `chg_${seq}`;
  return {
    id,
    hseq,
    at,
    seq,
    chapter: 1,
    chapterTitle: null,
    premise: false,
    premiseLanded: false,
    alias: 'Филипп',
    cause: 'reader',
    status: 'done',
    outcome: 'applied',
    reason: null,
    changeId: id,
    recordHref: `?change=${id}`,
    span: null,
  };
}

/** Newest first, as the API sends them: 10 at 27.10 15:40, 7 at 26.10 09:00, 4 at 21.10 09:12. */
const ITEMS: HistoryRecordDto[] = [
  record(10, '2026-10-27T12:40:00Z', 9),
  record(7, '2026-10-26T06:00:00Z', 8),
  record(4, '2026-10-21T06:12:00Z', 3),
];

function page(items: HistoryRecordDto[], lastHseq: number, nextBefore: number | null = null): HistoryTimelineDto {
  // The log's own last moment travels with the page; these fixtures put it on the newest row.
  // `firstAt` is the log's oldest row — the starting record (`null` on an empty log).
  return {
    lastHseq,
    lastAt: items[0]?.at ?? null,
    firstAt: items.at(-1)?.at ?? null,
    at: '2026-10-27T12:40:00Z',
    items,
    nextBefore,
  };
}

function bookAt(hseq: number): BookAtDto {
  return {
    hseq,
    at: '2026-10-26T06:00:00Z',
    front: { rev: 1, title: 'Книга момента', about: null },
    chapters: [],
    lastHseq: 10,
  };
}

/** `readJson` needs only `ok` and `json()` on the happy path; no jsdom `fetch`/`Response`. */
function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response;
}

function refusal(): Response {
  return {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    json: async () => ({ code: 'internal', message: 'internal' }),
  } as unknown as Response;
}

type Handler = (url: string) => Response | Promise<Response>;

/** The little of a `vi.fn` this file reads: which URLs were asked for, in order. */
type FetchMock = { mock: { calls: unknown[][] } };

function stubFetch(handler: Handler): FetchMock {
  const mock = vi.fn((input: string | URL | Request) => Promise.resolve(handler(String(input))));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** The `n` of every `/api/history/at/<n>` asked for, in order. */
function askedAt(mock: FetchMock): string[] {
  return mock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith('/api/history/at/'))
    .map((url) => url.slice('/api/history/at/'.length));
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
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let root: Root | null = null;
let container: HTMLDivElement;

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Chronicle catalog={[]} frontRev={1} tick={0} started live />);
  });
}

function range(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="range"]');
  if (input === null) throw new Error('the rail is not rendered');
  return input;
}

/** A native `input` event past React's value tracker: the same event a drag sends. */
function dragTo(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(range(), value);
  act(() => {
    range().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function releaseAt(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(range(), value);
  act(() => {
    range().dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
}

function readout(): string {
  return container.querySelector('.scrub-moment')?.textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the moment rail under a browser (BOOK-DOC-50 §4, §6)', () => {
  it('draws no tick marks and fills the rail through CSSOM', async () => {
    stubFetch(() => answer(page(ITEMS, 10)));
    mount();
    await flush();

    expect(container.querySelector('.scrub-ticks')).toBeNull();
    expect(container.querySelector('.scrub-ticks i')).toBeNull();
    // The traversed part is a CSSOM write on the fill, not a style attribute in the markup.
    const fill = container.querySelector<HTMLElement>('.scrub-fill');
    expect(fill?.style.width).toBe('100%');
    expect(container.querySelector('.scrub-range')?.getAttribute('style')).toBeNull();

    dragTo('7');
    expect(fill?.style.width).toBe('70%');
  });

  it('moves the readout with no request while the thumb is moving', async () => {
    const fetchMock = stubFetch(() => answer(page(ITEMS, 10)));
    mount();
    await flush();
    const before = askedAt(fetchMock).length;

    dragTo('7');
    expect(readout()).toContain(`26.10.2026${MID}09:00`);
    expect(container.querySelector('.scrub-count')?.textContent).toBe('запись 2 из 3');
    expect(askedAt(fetchMock)).toHaveLength(before);
  });

  it('asks once when the drag idles, and an answer for another moment is a failure with a retry', async () => {
    let lies = true;
    const fetchMock = stubFetch((url) => {
      if (!url.startsWith('/api/history/at/')) return answer(page(ITEMS, 10));
      const hseq = Number(url.slice('/api/history/at/'.length));
      // The server echoes the requested hseq (clamped); here the first answer is for another one.
      return answer(bookAt(lies ? 4 : hseq));
    });
    mount();
    await flush();

    dragTo('5');
    dragTo('6');
    dragTo('7');
    await advance(120);
    expect(askedAt(fetchMock)).toEqual(['7']);
    // The answer is for hseq 4, so the book of another moment must not paint…
    expect(container.querySelector('.past-cover')).toBeNull();
    // …and it must not leave the skeleton standing: the mismatch is the failure state (§7).
    expect(container.querySelector('.past-note')?.textContent).toContain('момент не прочитался');
    expect(container.querySelector('.skel')).toBeNull();
    // The readout keeps its date: it comes from the loaded log, not from the answer.
    expect(readout()).toContain(`26.10.2026${MID}09:00`);

    // The retry asks for the thumb's own hseq again; this time the past paints.
    lies = false;
    const retry = container.querySelector<HTMLButtonElement>('.past-retry');
    expect(retry?.textContent).toBe('повторить');
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(askedAt(fetchMock)).toEqual(['7', '7']);
    expect(container.querySelector('.past-cover')).not.toBeNull();
    expect(container.querySelector('.past-note')?.textContent).toContain('так книга выглядела в');
  });

  it('renders the past when the answer is for the thumb', async () => {
    stubFetch((url) =>
      url.startsWith('/api/history/at/') ? answer(bookAt(Number(url.slice('/api/history/at/'.length)))) : answer(page(ITEMS, 10)),
    );
    mount();
    await flush();

    dragTo('7');
    await advance(120);
    expect(container.querySelector('.past-cover')?.textContent).toContain('Книга момента');
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('.past-note')?.textContent).toContain('так книга выглядела в');
  });

  it('asks at once on release, without waiting for the idle', async () => {
    const fetchMock = stubFetch((url) =>
      url.startsWith('/api/history/at/') ? answer(bookAt(Number(url.slice('/api/history/at/'.length)))) : answer(page(ITEMS, 10)),
    );
    mount();
    await flush();

    dragTo('4');
    releaseAt('4');
    await advance(0);
    expect(askedAt(fetchMock)).toEqual(['4']);
    expect(container.querySelector('.past-cover')).not.toBeNull();
  });

  it('lets a later request replace an earlier one, so an old answer never paints (§5–§6)', async () => {
    const pending = new Map<string, (body: unknown) => void>();
    const fetchMock = stubFetch((url) => {
      if (!url.startsWith('/api/history/at/')) return answer(page(ITEMS, 10));
      const hseq = url.slice('/api/history/at/'.length);
      return new Promise<Response>((resolve) => {
        pending.set(hseq, (body) => resolve(answer(body)));
      });
    });
    mount();
    await flush();

    dragTo('7');
    await advance(120);
    dragTo('4');
    await advance(120);
    expect(askedAt(fetchMock)).toEqual(['7', '4']);

    const settle = async (hseq: string, body: unknown): Promise<void> => {
      await act(async () => {
        pending.get(hseq)?.(body);
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    // The second request answers first and paints its own moment…
    await settle('4', { ...bookAt(4), front: { rev: 1, title: 'Момент 4', about: null } });
    expect(container.querySelector('.past-title')?.textContent).toBe('Момент 4');
    // …then the earlier answer arrives late: it may not replace the later one.
    await settle('7', { ...bookAt(7), front: { rev: 1, title: 'Момент 7', about: null } });
    expect(container.querySelector('.past-title')?.textContent).toBe('Момент 4');
    expect(container.textContent).not.toContain('Момент 7');
  });

  it('keeps the readout’s date through a failure and refetches that hseq on «повторить»', async () => {
    let fail = true;
    const fetchMock = stubFetch((url) => {
      if (!url.startsWith('/api/history/at/')) return answer(page(ITEMS, 10));
      const hseq = Number(url.slice('/api/history/at/'.length));
      return fail ? refusal() : answer(bookAt(hseq));
    });
    mount();
    await flush();

    dragTo('4');
    await advance(120);
    expect(container.querySelector('.past-note')?.textContent).toContain('момент не прочитался');
    expect(readout()).toContain(`21.10.2026${MID}09:12`);
    expect(range().value).toBe('4');
    // A failure is not a wait: no form of any kind is left standing for it.
    expect(container.querySelector('.skel')).toBeNull();

    fail = false;
    const retry = container.querySelector<HTMLButtonElement>('.past-retry');
    expect(retry?.textContent).toBe('повторить');
    await act(async () => {
      retry?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(askedAt(fetchMock)).toEqual(['4', '4']);
    expect(container.querySelector('.past-note')?.textContent).toContain('так книга выглядела в');
    expect(container.querySelector('.past-cover')).not.toBeNull();
  });

  it('says «момент читается» after 150 ms and names the slow read at 2 000 ms', async () => {
    stubFetch((url) => (url.startsWith('/api/history/at/') ? new Promise<Response>(() => undefined) : answer(page(ITEMS, 10))));
    mount();
    await flush();

    dragTo('7');
    await advance(120);
    // The fetch has started but nothing is said yet: the date is enough for 150 ms.
    expect(container.querySelector('.past-note')?.textContent).toBe('');
    await advance(150);
    expect(container.querySelector('.past-note')?.textContent).toContain('момент читается');
    // The wait has a form of its own: one skeleton from the one system (BOOK-66).
    expect(container.querySelector('.skel-chronicle')).not.toBeNull();
    await advance(2_000);
    expect(container.querySelector('.past-note')?.textContent).toContain('момент идёт дольше обычного · книга появится здесь же');
  });

  it('walks one record per arrow key and takes the ends on Home and End', async () => {
    stubFetch((url) =>
      url.startsWith('/api/history/at/') ? answer(bookAt(Number(url.slice('/api/history/at/'.length)))) : answer(page(ITEMS, 10)),
    );
    mount();
    await flush();

    const key = (name: string): void => {
      act(() => {
        range().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
      });
    };

    key('ArrowLeft');
    expect(readout()).toContain(`26.10.2026${MID}09:00`);
    key('ArrowLeft');
    expect(readout()).toContain(`21.10.2026${MID}09:12`);
    key('ArrowLeft');
    expect(readout()).toContain(`21.10.2026${MID}09:12`);
    key('ArrowRight');
    expect(readout()).toContain(`26.10.2026${MID}09:00`);
    key('End');
    expect(readout()).toContain(`27.10.2026${MID}15:40`);
    key('Home');
    expect(readout()).toContain(`21.10.2026${MID}09:12`);
    // The readout is the range's own value text, so assistive tech reads the same moment.
    expect(range().getAttribute('aria-valuetext')).toBe(container.querySelector('.scrub-moment')?.textContent);
  });

  it('commits a key stop on keyup with exactly one request for that record (§5)', async () => {
    const fetchMock = stubFetch((url) =>
      url.startsWith('/api/history/at/')
        ? answer(bookAt(Number(url.slice('/api/history/at/'.length))))
        : answer(page(ITEMS, 10)),
    );
    mount();
    await flush();

    act(() => {
      range().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // A key moves the readout in the same frame and asks nothing.
    expect(readout()).toContain(`26.10.2026${MID}09:00`);
    expect(askedAt(fetchMock)).toEqual([]);

    act(() => {
      range().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    });
    await advance(0);
    expect(askedAt(fetchMock)).toEqual(['7']);
    expect(container.querySelector('.past-cover')).not.toBeNull();

    // The release cancelled the idle: the same stop is never asked for twice.
    await advance(200);
    expect(askedAt(fetchMock)).toEqual(['7']);
  });

  it('has no readout, no ends and no rail while nothing is logged', async () => {
    stubFetch(() => answer(page([], 0)));
    mount();
    await flush();

    expect(container.querySelector('.scrub')).toBeNull();
    expect(container.textContent).toContain('пока ничего не записано');
    expect(container.querySelector('.chr-ends')).toBeNull();
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('prints the one starting record of a begun book and still no rail (BOOK-56)', async () => {
    // The log holds its first moment and no reader change: the chronicle exists, with exactly
    // one record — «начало книги» — and nothing to rewind yet.
    stubFetch(() => answer({ ...page([], 3), lastAt: '2026-10-21T06:12:00Z', firstAt: '2026-10-21T06:12:00Z' }));
    mount();
    await flush();

    const rows = container.querySelectorAll('li.chr-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe(`начало книги${`21.10.2026${MID}09:12`}`);
    expect(container.textContent).toContain('перематывать пока нечего: книга ещё не правила читателем');
    expect(container.textContent).not.toContain('пока ничего не записано');
    // Nothing to scrub: no control, no rail, no ends, no readout — and no button at all.
    expect(container.querySelector('.scrub')).toBeNull();
    expect(container.querySelector('.chr-ends')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // The surface settled: it is not busy and prints no wait.
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('section.chronicle')?.hasAttribute('aria-label')).toBe(true);
  });
});

describe('the moment’s read from the control (BOOK-DOC-43 §10, BOOK-65)', () => {
  it('leaves the loading line on failure, and retries the same hseq', async () => {
    let atCalls = 0;
    const fetchMock = stubFetch((url) => {
      if (url.startsWith('/api/history/at/')) {
        atCalls += 1;
        return atCalls === 1 ? refusal() : answer(bookAt(Number(url.slice('/api/history/at/'.length))));
      }
      return answer(page(ITEMS, 10));
    });
    mount();
    await flush();

    // The moment moves only through the control: a drag to the oldest record asks for 4.
    dragTo('4');
    await advance(120);
    await flush();

    // The wait is over: no «момент читается», one failure line, one retry for that hseq.
    expect(container.textContent).toContain('момент не прочитался');
    expect(container.textContent).not.toContain('момент читается');
    expect(container.querySelector('.skel')).toBeNull();
    const retry = container.querySelector<HTMLButtonElement>('.past-retry');
    expect(retry?.textContent).toBe('повторить');

    await act(async () => retry?.click());
    await flush();

    expect(askedAt(fetchMock)).toEqual(['4', '4']);
    expect(container.textContent).not.toContain('момент не прочитался');
    expect(container.querySelector('.past-title')?.textContent).toBe('Книга момента');
  });

});
