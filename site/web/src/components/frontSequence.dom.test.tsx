// @vitest-environment jsdom
import type { FrontDto, StateSnapshot } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GATE_ATTRIBUTE } from '../lib/frontSequence.ts';
import type { TitleMotion } from '../lib/titleChange.ts';
import { BootWait } from './BootWait.tsx';
import { Opening } from './Opening.tsx';

/**
 * BOOK-DOC-49 §2, §3, §5, §7 — the first load, proved on the commit where the front lands.
 *
 * `Opening` is the component that mounts exactly then, so `t = 0` is its commit: no socket, no
 * analytics, no catalogue. The printing loop is driven frame by frame through a stubbed
 * `requestAnimationFrame`, which is how the two things the spec pins can be read at all: the
 * empty title line with its caret in the first frame, and the caret's 220 ms rest before it
 * leaves. Everything after that is fake timers — the 1 920 ms gate and the skip.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ABOUT = Array.from({ length: 9 }, (_, index) => `Абзац страницы 2 номер ${index + 1}.`).join('\n\n');

const front: FrontDto = {
  title: 'Бланк',
  about: ABOUT,
  rev: 1,
  toc: [],
  imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
  authors: { count: 0, measuredAt: '2026-10-27T08:00:00Z' },
};

/** Only the fields `Header` reads: the opening renders no inventory above the annotation. */
const state = {
  version: 1,
  at: '',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: front.title, about: front.about, rev: 1, updatedAt: null },
  chapters: { total: 42, written: [], empty: [], count: 0, totalChars: 0 },
  cursors: {},
  toc: [],
  meeting: { forwardFront: null, backwardFront: null, gap: 42, converged: false, seam: 'not_reached' },
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
} as unknown as StateSnapshot;

let root: Root | null = null;
let container: HTMLDivElement;
let errorCount: () => number = () => 0;
let restoreConsole: () => void = () => undefined;
/** Put `document.visibilityState` back if a case wrote it: jsdom's own getter is not writable. */
let restoreVisibility: () => void = () => undefined;
/** The frames the driver asked for and the test has not run yet. */
let frames: FrameRequestCallback[] = [];

/** jsdom implements no `matchMedia`; the reveal asks it, and a throw there would look like a bug. */
function motion(still: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: still && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** A background tab: §5 ends the sequence when the reader leaves the page, not when it returns. */
function tabHidden(): void {
  const own = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  restoreVisibility = () => {
    restoreVisibility = () => undefined;
    if (own === undefined) Reflect.deleteProperty(document, 'visibilityState');
    else Object.defineProperty(document, 'visibilityState', own);
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  motion(false);
  frames = [];
  restoreVisibility = () => undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    frames.push(callback);
    return frames.length;
  });
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  errorCount = () => spy.mock.calls.length;
  restoreConsole = () => spy.mockRestore();
  document.documentElement.removeAttribute(GATE_ATTRIBUTE);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute(GATE_ATTRIBUTE);
  // A hash left behind by one case would silently forbid the sequence in the next one.
  if (window.location.hash !== '') window.location.hash = '';
  restoreVisibility();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreConsole();
});

async function render(overrides: { front?: FrontDto; motion?: TitleMotion } = {}): Promise<void> {
  await act(async () => {
    root?.render(
      <Opening
        front={overrides.front ?? front}
        state={state}
        ribbon={null}
        catalog={[]}
        escalation={[]}
        onOpenChange={() => undefined}
        view="book"
        onViewChange={() => undefined}
        motion={overrides.motion}
        live
      />,
    );
  });
}

/** Run the frames the driver queued, at the moment the test names. */
async function frame(now: number): Promise<void> {
  await act(async () => {
    const queued = frames;
    frames = [];
    for (const callback of queued) callback(now);
  });
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

const gate = (): string | null => document.documentElement.getAttribute(GATE_ATTRIBUTE);
const tagged = (): Element[] => [...document.querySelectorAll('[data-seq]')];
const heading = (): HTMLElement => {
  const found = container.querySelector('h1');
  if (found === null) throw new Error('the cover has no title');
  return found;
};
const caret = (): Element | null => container.querySelector('.caret-inline');

describe('the commit where the data lands (BOOK-DOC-49 §2)', () => {
  it('writes the gate before paint and tags the 18 blocks in document order', async () => {
    await render();
    expect(gate()).toBe('run');
    // BOOK-131: the plate is the sheet's last child, so it is the fifth node here — after the
    // promise — while its turn in `SEQ_BLOCKS` is the byline's 500 ms slot.
    expect(tagged().map((node) => node.getAttribute('data-seq'))).toEqual([
      'title',
      'byline',
      'genre',
      'promise',
      'cover',
      'how-1',
      'how-2',
      'how-3',
      'rule',
      'about-1',
      'about-2',
      'about-3',
      'about-4',
      'about-5',
      'about-6',
      'about-7',
      'about-8',
      'about-9',
    ]);
    // The sheet owns the delays: no block carries a `style` attribute (the CSP has no
    // `style-src-attr`), and the gate hangs every rule on one value.
    expect(container.innerHTML).not.toContain('style=');
    expect(errorCount()).toBe(0);
  });

  it('the first frame is an empty title line with a caret, and the word is never doubled', async () => {
    await render();
    const title = heading();
    // §3: the line box is held by the caret, not by reserving the text.
    expect(title.textContent).toBe('');
    expect(caret()).not.toBeNull();
    // One copy of the word at every moment: a prefix of it, never a ghost beside it.
    expect(title.getAttribute('aria-label')).toBe('Бланк');
    expect(title.children).toHaveLength(1);
    expect(title.children[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(title.getAttribute('data-caret')).toBe('typing');
    // The boot sentence left with the commit that mounted the cover (§6).
    expect(container.textContent).not.toContain('опись читается');
    expect(errorCount()).toBe(0);
  });

  it('types at 18 cps, rests the caret 220 ms and removes it, all through the one engine', async () => {
    await render();
    const title = heading();
    // Frame 1 only fixes the loop's origin; a grapheme lands on the frames that follow.
    await frame(0);
    expect(title.textContent).toBe('');
    await frame(200);
    // 200 ms at 18 cps is three of the five graphemes: 5 × 200 ÷ 277.8 = 3.6, floored.
    expect(title.textContent).toBe('Бла');
    expect(caret()?.classList.contains('blink')).toBe(true);

    // 277.8 ms of typing: the last grapheme lands, and the caret greys instead of leaving.
    await frame(278);
    expect(title.textContent).toBe('Бланк');
    expect(title.getAttribute('data-caret')).toBe('resting');
    expect(caret()?.classList.contains('resting')).toBe(true);

    // …and is gone 220 ms later, at 498 for the five-grapheme word. Nothing adopts it.
    await wait(219);
    expect(caret()).not.toBeNull();
    await wait(1);
    expect(caret()).toBeNull();
    expect(title.getAttribute('data-caret')).toBeNull();
    expect(frames).toHaveLength(0);
    expect(gate()).toBe('run');
    expect(errorCount()).toBe(0);
  });

  it('clears the gate to `done` at 1 920 ms and leaves the tags inert, not removed', async () => {
    await render();
    const title = heading();
    expect(gate()).toBe('run');
    await wait(1_919);
    expect(gate()).toBe('run');
    expect(title.textContent).toBe('');
    await wait(1);
    expect(gate()).toBe('done');
    // Whatever the loop did, the page is final at the gate: the whole word, no caret left.
    expect(title.textContent).toBe('Бланк');
    expect(caret()).toBeNull();
    expect(tagged()).toHaveLength(18);
    expect(vi.getTimerCount()).toBe(0);
    expect(errorCount()).toBe(0);
  });

  it('keeps the caret element itself aria-hidden in both of its phases', async () => {
    await render();
    await frame(0);
    await frame(200);
    // §3: the wrapper is hidden too, but this pins the mark the CSS actually draws — the caret
    // is its own element, blinking and then resting, and it is silent in both phases.
    expect(caret()?.classList.contains('blink')).toBe(true);
    expect(caret()?.getAttribute('aria-hidden')).toBe('true');
    await frame(278);
    expect(caret()?.classList.contains('resting')).toBe(true);
    expect(caret()?.getAttribute('aria-hidden')).toBe('true');
    expect(errorCount()).toBe(0);
  });
});

describe('the skip (BOOK-DOC-49 §5)', () => {
  it('ends on a keydown: the gate is done, the title is whole, the listeners are gone', async () => {
    await render();
    expect(heading().textContent).toBe('');
    const removed = vi.spyOn(window, 'removeEventListener');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'а' }));
    });
    expect(gate()).toBe('done');
    expect(heading().textContent).toBe('Бланк');
    expect(caret()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // §5: nothing of the sequence outlives its own end — every listener it registered is off.
    expect(removed.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(['scroll', 'pointerdown', 'keydown']),
    );
    expect(errorCount()).toBe(0);
  });

  it('ends when the tab goes hidden, and only then: a visible report leaves the run alone', async () => {
    await render();
    expect(heading().textContent).toBe('');

    // jsdom is a visible document: the listener is registered for both directions, but §5 spends
    // the sequence when the reader *leaves*, not on every visibility report.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(gate()).toBe('run');
    expect(caret()).not.toBeNull();

    tabHidden();
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(gate()).toBe('done');
    expect(heading().textContent).toBe('Бланк');
    expect(caret()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(errorCount()).toBe(0);
  });

  it('ends on a scroll, and a later mount in the same document inherits the final page', async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(gate()).toBe('done');
    expect(heading().textContent).toBe('Бланк');

    // A fresh mount of the same document: the gate it finds is `done`, so the run does not
    // happen twice — and every selector hangs on `run`, so the untagged page is the final one,
    // not an invisible one (§2).
    if (root !== null) await act(async () => root?.unmount());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await render({ front: { ...front, rev: 2 } });
    expect(gate()).toBe('done');
    expect(tagged()).toHaveLength(0);
    expect(heading().textContent).toBe('Бланк');
    expect(caret()).toBeNull();
    expect(errorCount()).toBe(0);
  });
});

describe('a front:updated finishes the sequence first (BOOK-DOC-49 §2d)', () => {
  it('leaves an empty title whole and names it before the ripple keys the heading', async () => {
    await render();
    await frame(0);
    await frame(120);
    expect(heading().textContent).not.toBe('Бланк');

    await render({ front: { ...front, title: 'Бланк II', rev: 2 }, motion: { token: 1, mode: 'ripple' } });
    expect(gate()).toBe('done');
    const title = heading();
    expect(title.textContent).toBe('Бланк II');
    expect(title.getAttribute('aria-label')).toBe('Бланк II');
    expect(caret()).toBeNull();
    expect(title.className).toContain('title-ripple');
    expect(errorCount()).toBe(0);
  });
});

describe('the page loads that own no sequence (BOOK-DOC-49 §2b, §5, §7)', () => {
  it('writes no gate and tags nothing under reduced motion: the page is final at first paint', async () => {
    motion(true);
    await render();
    expect(document.documentElement.hasAttribute(GATE_ATTRIBUTE)).toBe(false);
    expect(tagged()).toHaveLength(0);
    const title = heading();
    expect(title.textContent).toBe('Бланк');
    expect(caret()).toBeNull();
    await wait(2_000);
    expect(title.textContent).toBe('Бланк');
    expect(errorCount()).toBe(0);
  });

  it('writes no gate on a deep link, and still tags nothing behind it', async () => {
    window.location.hash = '#ch-12';
    await render();
    expect(document.documentElement.hasAttribute(GATE_ATTRIBUTE)).toBe(false);
    expect(tagged()).toHaveLength(0);
    expect(heading().textContent).toBe('Бланк');
    window.location.hash = '';
    expect(errorCount()).toBe(0);
  });

  it('renders no sequence node at all while the data has not landed', async () => {
    // App.tsx renders this and nothing else in that branch (`data === null`): the waiting page
    // owns no `[data-seq]`, so a sequence cannot start before the front arrives.
    await act(async () => {
      root?.render(
        <main className="page boot-wait" aria-busy="true">
          <BootWait active />
        </main>,
      );
    });
    expect(tagged()).toHaveLength(0);
    expect(document.documentElement.hasAttribute(GATE_ATTRIBUTE)).toBe(false);
    expect(errorCount()).toBe(0);
  });
});
