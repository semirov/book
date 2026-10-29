// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFrontSequence } from '../useFrontSequence.ts';
import { GATE_ATTRIBUTE, GATE_DONE, GATE_RUN } from './frontSequence.ts';
import { applyStickyOffsets } from './headerOffset.ts';
import { landingLine } from './landing.ts';
import { PLACE_KEY, readPlace } from './placeStore.ts';
import type { Place } from './position.ts';
import { forgetBootPlace, jumpToChapter, usePosition } from './usePosition.ts';

/**
 * BOOK-209 — the signed-in half of the position layer, and the capture's own edges: the server
 * row is what a second device resumes, a `PUT` is spent at most once every ten seconds and
 * always when the page leaves, a gesture kills a resume, a click that is not a same-document
 * anchor records nothing, and a browser that refuses the history still lands the chapter.
 *
 * jsdom has no layout and no frame clock: the page's geometry is a table in document
 * coordinates and `requestAnimationFrame` is a queue this file drains by hand.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HEAD = 56;
const VIEWPORT = 844;
const LINE = HEAD + 16;

const BOOK = `
  <header class="top"></header>
  <article data-n="1" id="ch-1" data-rev="1">
    <header class="ch-h"></header>
    <p id="ch-1-b1" data-block-id="ch01#aaaaaaaa">
      <span data-s="0" data-quote="Первое предложение главы первой."></span>
      <span data-s="40" data-quote="Второе предложение главы первой."></span>
    </p>
  </article>
  <article data-n="2" id="ch-2" data-rev="1">
    <header class="ch-h"></header>
    <p id="ch-2-b1" data-block-id="ch02#bbbbbbbb">
      <span data-s="0" data-quote="Первое предложение главы второй."></span>
    </p>
  </article>
`;

const BOXES: ReadonlyArray<readonly [string, number, number]> = [
  ['#ch-1', 900, 600],
  ['#ch-1 .ch-h', 900, 40],
  ['#ch-1-b1', 1_000, 200],
  ['#ch-1 [data-s="0"]', 1_000, 20],
  ['#ch-1 [data-s="40"]', 1_060, 20],
  ['#ch-2', 1_600, 500],
  ['#ch-2 .ch-h', 1_600, 40],
  ['#ch-2-b1', 1_700, 100],
  ['#ch-2 [data-s="0"]', 1_700, 20],
];

const scroll = { y: 0 };
let queued: Array<{ id: number; callback: FrameRequestCallback }> = [];
let nextId = 1;
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scroll.y = Number(options.top ?? 0);
});
const scrollBy = vi.fn((options: ScrollToOptions) => {
  scroll.y += Number(options.top ?? 0);
});

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function mountPage(): void {
  document.body.innerHTML = BOOK;
  const head = document.querySelector<HTMLElement>('.top');
  if (head !== null) head.getBoundingClientRect = () => rect(0, HEAD);
  for (const [selector, top, height] of BOXES) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element !== null) element.getBoundingClientRect = () => rect(top - scroll.y, height);
  }
  applyStickyOffsets(document);
}

async function pump(times = 10): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      const due = queued;
      queued = [];
      for (const entry of due) entry.callback(index * 16);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}

function boxTop(selector: string): number {
  return document.querySelector(selector)?.getBoundingClientRect().top ?? Number.NaN;
}

const place = (overrides: Partial<Place> = {}): Place => ({
  chapter: 1,
  sentenceId: 'ch01#aaaaaaaa/s0',
  deltaPx: 0,
  at: '2026-10-29T08:00:00.000Z',
  ...overrides,
});

function ChapterLink() {
  return (
    <a
      id="toc-2"
      href="#ch-2"
      onClick={(event) => {
        if (jumpToChapter(2)) event.preventDefault();
      }}
    >
      глава 2
    </a>
  );
}

function Probe({ ready, signedIn = false }: { ready: boolean; signedIn?: boolean }) {
  usePosition(ready, signedIn);
  return <ChapterLink />;
}

/** The same page with the cover's sequence mounted beside the position layer, as `App` mounts it. */
function FrontProbe({ ready, signedIn = false }: { ready: boolean; signedIn?: boolean }) {
  usePosition(ready, signedIn);
  useFrontSequence(0);
  return <ChapterLink />;
}

let container: HTMLDivElement;
let root: Root | null = null;

function mount(ready: boolean, signedIn = false): void {
  act(() => root?.render(<Probe ready={ready} signedIn={signedIn} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  forgetBootPlace();
  window.localStorage.clear();
  scroll.y = 0;
  queued = [];
  nextId = 1;
  mountPage();
  // A gate a previous case left behind would silently forbid this case's sequence.
  document.documentElement.removeAttribute(GATE_ATTRIBUTE);
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scroll.y });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 4_000 });
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollBy', scrollBy);
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queued.push({ id: nextId, callback });
    nextId += 1;
    return nextId - 1;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queued = queued.filter((entry) => entry.id !== id);
  });
  vi.stubGlobal('matchMedia', () => ({ matches: false, media: '', addEventListener: () => undefined, removeEventListener: () => undefined }));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container.remove();
  document.documentElement.removeAttribute(GATE_ATTRIBUTE);
  // The history mocks of this file's own cases are undone before the entry is reset.
  vi.restoreAllMocks();
  window.location.hash = '';
  window.history.replaceState(null, '');
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('signed in: the server row is the second device', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  function stubApi(remote: Place | null, fail = false): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        if (fail) throw new Error('offline');
        if (init?.method === 'PUT') return new Response(null, { status: 204 });
        if (remote === null) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(remote), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  beforeEach(() => {
    calls.length = 0;
  });

  it('resumes the newer server row, not the older local one', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place({ at: '2026-10-29T08:00:00.000Z' })));
    forgetBootPlace();
    stubApi(place({ chapter: 2, sentenceId: 'ch02#bbbbbbbb/s0', deltaPx: 5, at: '2026-10-29T09:30:00.000Z' }));

    await act(async () => root?.render(<Probe ready signedIn />));
    await pump(12);

    expect(calls.some((call) => call.url === '/api/me/place' && (call.init.method ?? 'GET') === 'GET')).toBe(true);
    // ch02's own sentence, at the line plus the delta that row carried.
    expect(boxTop('#ch-2 [data-s="0"]')).toBeCloseTo(landingLine() + 5, 1);
  });

  it('keeps the local place when the server cannot answer', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place()));
    forgetBootPlace();
    stubApi(null, true);

    await act(async () => root?.render(<Probe ready signedIn />));
    await pump(12);
    expect(boxTop('#ch-1 [data-s="0"]')).toBeCloseTo(landingLine(), 1);
  });

  it('puts the place at most once every ten seconds, and always on pagehide', async () => {
    stubApi(null);
    mount(true, true);
    await pump(0);

    scroll.y = 940;
    await act(async () => window.dispatchEvent(new Event('scroll')));
    await pump(2);
    const put = (): number => calls.filter((call) => call.init.method === 'PUT').length;
    expect(put()).toBe(1);
    // The body is exactly the four fields the route accepts, and no identity of any kind.
    const body = JSON.parse(String(calls.find((call) => call.init.method === 'PUT')?.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['at', 'chapter', 'deltaPx', 'sentenceId']);

    // A second scroll inside the window sends nothing…
    await act(async () => window.dispatchEvent(new Event('scroll')));
    await pump(2);
    expect(put()).toBe(1);

    // …and a page that is leaving writes once more, whatever the throttle says.
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    expect(put()).toBe(2);
  });

  it('writes on the page going hidden, and not when it comes back', async () => {
    stubApi(null);
    mount(true, true);
    await pump(0);
    scroll.y = 940;

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(readPlace()).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s0' });
    const writes = calls.filter((call) => call.init.method === 'PUT').length;
    expect(writes).toBe(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(calls.filter((call) => call.init.method === 'PUT').length).toBe(writes);
    delete (document as { visibilityState?: string }).visibilityState;
  });
});

describe('a second device: the server row is the only row', () => {
  it('settles the cover sequence before the resume lands, and lands the server’s place', async () => {
    const remote = place({ chapter: 2, sentenceId: 'ch02#bbbbbbbb/s0', deltaPx: 5, at: '2026-10-29T09:30:00.000Z' });
    let release: (() => void) | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') return new Response(null, { status: 204 });
        // The answer is held: until it arrives this page is the cover, and nothing in the store
        // says otherwise (`resumePending` could not skip a sequence there is no row for).
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response(JSON.stringify(remote), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    await act(async () => root?.render(<FrontProbe ready signedIn />));
    expect(document.documentElement.getAttribute(GATE_ATTRIBUTE)).toBe(GATE_RUN);

    await act(async () => {
      release?.();
    });
    await pump(12);

    // The sequence is finished whole (not left printing over the jump) and the place is landed.
    expect(document.documentElement.getAttribute(GATE_ATTRIBUTE)).toBe(GATE_DONE);
    expect(boxTop('#ch-2 [data-s="0"]')).toBeCloseTo(landingLine() + 5, 1);
  });
});

describe('a place the server refuses', () => {
  /** The API, as the two answers that must be told apart: a refusal and a network that is down. */
  function stubPut(kind: 'refused' | 'offline'): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'PUT') return new Response(null, { status: 204 });
        if (kind === 'offline') throw new Error('offline');
        return new Response(JSON.stringify({ code: 'BAD_PLACE', message: 'место не сохранено' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  }

  it('leaves one operator line per document for a 400 BAD_PLACE', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stubPut('refused');
    mount(true, true);
    await pump(0);

    scroll.y = 940;
    await act(async () => window.dispatchEvent(new Event('scroll')));
    await pump(2);
    expect(info.mock.calls).toHaveLength(1);
    expect(info.mock.calls[0]?.[0]).toBe('position: the server refused a place (400 BAD_PLACE) ch01#aaaaaaaa/s0');

    // A page that is leaving writes again, and the refusal is the same bug: still one line.
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    await pump(2);
    expect(info.mock.calls).toHaveLength(1);
  });

  it('says nothing when the network is down: a place is worth no line of the reader’s log', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    stubPut('offline');
    mount(true, true);
    await pump(0);
    scroll.y = 940;
    await act(async () => window.dispatchEvent(new Event('scroll')));
    await pump(2);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('the throttle keeps the last place, not the first one in the second', () => {
  it('writes the trailing place a second after the scroll that was held', async () => {
    // The frame clock stays this file's own queue; only the wall clock and the timers are faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      mount(true);
      await pump(0);
      scroll.y = 940;
      await act(async () => window.dispatchEvent(new Event('scroll')));
      await pump(2);
      expect(readPlace()?.sentenceId).toBe('ch01#aaaaaaaa/s0');

      // A second scroll inside the same second: held, then written by the trailing timer.
      scroll.y = 1_000;
      await act(async () => window.dispatchEvent(new Event('scroll')));
      await pump(2);
      expect(readPlace()?.sentenceId).toBe('ch01#aaaaaaaa/s0');
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      expect(readPlace()).toMatchObject({ chapter: 1, sentenceId: 'ch01#aaaaaaaa/s40' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a resume the reader interrupts', () => {
  it('never lands when a gesture came first', async () => {
    window.localStorage.setItem(PLACE_KEY, JSON.stringify(place()));
    forgetBootPlace();
    mount(false);
    // The gesture comes after this page's listeners exist and before the catalogue is ready.
    await act(async () => {
      window.dispatchEvent(new Event('wheel'));
    });
    await act(async () => root?.render(<Probe ready />));
    await pump(12);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('a browser that refuses the history', () => {
  it('records nothing, lands nothing less, and keeps the page working', async () => {
    scroll.y = 940;
    mount(true);
    await pump(0);
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('denied');
    });
    // The capture listener must not take the page down with the refusal.
    expect(() =>
      document.getElementById('toc-2')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    ).not.toThrow();
    await pump(10);
    expect(boxTop('#ch-2 .ch-h')).toBeCloseTo(landingLine(), 1);
  });

  it('still lands a chapter whose entry cannot be pushed', async () => {
    mount(true);
    vi.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(jumpToChapter(2)).toBe(true);
    await pump(10);
    expect(boxTop('#ch-2 .ch-h')).toBeCloseTo(landingLine(), 1);
  });

  it('still lands with a history that refuses `scrollRestoration`', async () => {
    // The order is a courtesy (a reload restores the anchor, not a pixel); an engine that will
    // not take it keeps its own restore, and nothing else about the page changes.
    Object.defineProperty(window.history, 'scrollRestoration', {
      configurable: true,
      get: () => 'auto',
      set: () => {
        throw new Error('denied');
      },
    });
    try {
      expect(() => mount(true)).not.toThrow();
      await pump(0);
      expect(jumpToChapter(2)).toBe(true);
      await pump(10);
      expect(boxTop('#ch-2 .ch-h')).toBeCloseTo(landingLine(), 1);
    } finally {
      Reflect.deleteProperty(window.history, 'scrollRestoration');
    }
  });
});

describe('which clicks record a place', () => {
  function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}): void {
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
  }

  function anchor(attributes: Record<string, string>): HTMLAnchorElement {
    const node = document.createElement('a');
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    node.textContent = 'ссылка';
    document.body.append(node);
    return node;
  }

  it('records a same-document anchor and nothing else', async () => {
    scroll.y = 940;
    mount(true);
    await pump(0);
    const replace = vi.spyOn(window.history, 'replaceState');

    click(anchor({ href: '#ch-2' }));
    expect(replace).toHaveBeenCalledTimes(1);
    expect((replace.mock.calls[0]?.[0] as { bookPlace?: Place }).bookPlace).toMatchObject({ chapter: 1 });

    replace.mockClear();
    // A modified click opens a tab or saves a file; a second button is not a tap either.
    click(anchor({ href: '#ch-2' }), { metaKey: true });
    click(anchor({ href: '#ch-2' }), { button: 1 });
    click(anchor({ href: '#ch-2', download: '' }));
    click(anchor({ href: '#ch-2', target: '_blank' }));
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('the landing line this page measures', () => {
  it('is the head the page measured plus LANDING_PX, not a literal', () => {
    expect(landingLine()).toBe(LINE);
  });
});
