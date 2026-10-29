// @vitest-environment jsdom
import type { CatalogEntry, ChapterDto, ChapterRevisionPayload } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedRecord } from '../lib/appliedPrint.ts';
import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-DOC-84 §4/D2 — a write prints from its **applied record**, and nowhere else.
 *
 * The old path is gone: a refetch made while a pass was in flight no longer prints the
 * difference it revealed (`landed` is the pass's accounting, not the write's clock). The one
 * clock is `chapter:applied.appliedAt`, and the article mounts `LivePass` for the changed
 * blocks an applied record names. This file asserts both halves: the applied record prints,
 * and the same refetch without one replaces the text whole.
 *
 * The harness is `chapterArticle.dom.test.tsx`'s: one mount, re-renders driven by the props a
 * frame would bring, boxes injected through `getBoundingClientRect` (jsdom has no layout).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Comes into view at once: the prose is fetched and the printing reveal starts. */
class EagerObserver {
  constructor(private readonly callback: (records: Array<{ isIntersecting: boolean }>) => void) {}
  observe(): void {
    this.callback([{ isIntersecting: true }]);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

const LINE = 24;

const rect = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** Every grapheme of a live pass sits on one line of the block; the block itself is one line. */
function stubRects(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('p-pass')) return rect(0, 0, 342, LINE);
    const index = Number(this.getAttribute('data-i') ?? '-1');
    if (index < 0) return rect(0, 0, 0, 0);
    return rect(0, 8 + index * 6, 6, LINE);
  });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);
}

const ENTRY: CatalogEntry = {
  n: 1,
  part: 1,
  title: 'Тестовая глава',
  rev: 1,
  chars: 85,
  blocks: 3,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-20T09:20:00Z',
  updatedAt: '2026-10-20T09:20:00Z',
  direction: 'forward',
};

const LOADED: ChapterDto = {
  n: 1, title: null, rev: 1, chars: 85, basis: false, writtenAt: '2026-10-20T09:20:00Z', updatedAt: '2026-10-20T09:20:00Z',
  blocks: [
    { id: 'ch01#aaaa1111', i: 0, text: 'Первый абзац стоит на месте.', hash: 'a' },
    { id: 'ch01#bbbb2222', i: 1, text: 'Второй абзац до подхода писателя.', hash: 'b' },
    { id: 'ch01#cccc3333', i: 2, text: 'Третий абзац стоит на месте.', hash: 'c' },
  ],
};

const NEW_TEXT = 'Второй абзац, переписанный писателем на ходу.';

const REVISION: ChapterRevisionPayload = {
  n: 1,
  rev: 2,
  hseq: 5,
  title: null,
  chars: 100,
  delta: 15,
  kind: 'rewrite',
  cause: { changeId: null, cascadeId: null, wave: null, lane: 'forward', direction: 'forward', stepId: 'stp_1', seamsIn: [], seamsOut: [] },
  patch: [{ op: 'replace', id: 'ch01#bbbb2222', i: 1, newId: 'ch01#dddd4444', text: NEW_TEXT }],
  patchTruncated: false,
  attributed: true,
  updatedAt: '2026-10-20T09:21:00Z',
};

const APPLIED: AppliedRecord = {
  n: 1,
  rev: 2,
  appliedAt: Date.now(),
  patch: REVISION.patch,
  patchTruncated: false,
  span: [{ blockId: 'ch01#bbbb2222', before: LOADED.blocks[1]!.text, after: NEW_TEXT, truncated: false }],
};

const answer = (body: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let frames: FrameRequestCallback[] = [];
let clock = 0;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms: number): Promise<void> {
  const next = frames.shift();
  clock = Math.max(clock, performance.now()) + ms;
  await act(async () => next?.(clock));
}

type DrawProps = {
  entry?: CatalogEntry;
  revision?: ChapterRevisionPayload | null;
  applied?: AppliedRecord | null;
};

async function draw(props: DrawProps = {}): Promise<HTMLDivElement> {
  if (container === null) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(
      <ChapterArticle
        entry={props.entry ?? ENTRY}
        revision={props.revision ?? null}
        revising={null}
        caret={null}
        fresh={false}
        applied={props.applied ?? null}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        history
      />,
    );
  });
  await flush();
  return container;
}

beforeEach(() => {
  frames = [];
  clock = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  stubRects();
});

describe('a write prints from its applied record', () => {
  it('mounts the live renderer for the changed block only, then hands it back settled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(LOADED)));
    const view = await draw();
    expect(view.querySelector('.p-pass')).toBeNull();

    // The frame's own props: the write (applied) and the revision it carries (the patch).
    await draw({ entry: { ...ENTRY, rev: 2 }, revision: REVISION, applied: APPLIED });

    // One renderer, on the block the write named; the untouched paragraphs are ordinary.
    const passes = view.querySelectorAll('p.p-pass');
    expect(passes).toHaveLength(1);
    expect(passes[0]?.getAttribute('data-block-id')).toBe('ch01#dddd4444');
    expect(passes[0]?.getAttribute('data-pass')).not.toBe('settled');
    expect(view.querySelectorAll('[data-block-id="ch01#aaaa1111"]')).toHaveLength(1);
    expect(view.querySelector('[data-block-id="ch01#aaaa1111"]')?.className).not.toContain('p-pass');

    for (let step = 0; step < 24; step += 1) await tick(200);
    // Settled: the block is an ordinary paragraph again, and the prose never replays.
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.textContent).toContain(NEW_TEXT);
  });

  it('replaces the text whole when no applied record names it — the machine path', async () => {
    const fetchMock = vi.fn(async () => answer(fetchMock.mock.calls.length === 1 ? LOADED : { ...LOADED, rev: 2, blocks: [LOADED.blocks[0]!, { ...LOADED.blocks[1]!, id: 'ch01#dddd4444', text: NEW_TEXT }, LOADED.blocks[2]!] }));
    vi.stubGlobal('fetch', fetchMock);
    const view = await draw();
    await draw({ entry: { ...ENTRY, rev: 2 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.textContent).toContain(NEW_TEXT);
  });

  it('prints nothing for a truncated write: the page waits for the prose instead of guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(LOADED)));
    const view = await draw();
    await draw({
      entry: { ...ENTRY, rev: 2 },
      revision: { ...REVISION, patchTruncated: true },
      applied: { ...APPLIED, patchTruncated: true, span: null },
    });
    expect(view.querySelector('.p-pass')).toBeNull();
  });

  it('prints nothing for a write older than the six-second window', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(LOADED)));
    const view = await draw();
    await draw({
      entry: { ...ENTRY, rev: 2 },
      revision: REVISION,
      applied: { ...APPLIED, appliedAt: Date.now() - 6_001 },
    });
    expect(view.querySelector('.p-pass')).toBeNull();
  });
});
