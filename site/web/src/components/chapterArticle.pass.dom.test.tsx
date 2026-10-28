// @vitest-environment jsdom
import type { CatalogEntry, ChapterDto, PassStageEvent } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { applyStage, type Passes } from '../lib/passes.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * A landed writer pass reaches the page as **text**, not as a `chapter:revision` frame: the
 * revision row is written by the engine, the site's watcher then finds the file already
 * ingested and publishes nothing. The one fact the page has is the pass itself (`pass:stage`
 * — `lib/passes.ts`), so the refetch it was going to make anyway prints what the pass wrote.
 *
 * The harness is `chapterArticle.dom.test.tsx`'s: one mount, re-renders driven by the props a
 * frame would bring, animation frames pulled by hand so «prints over ticks» is measurable.
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
const APPLIED: ChapterDto = {
  ...LOADED, rev: 2, chars: 100, updatedAt: '2026-10-20T09:21:00Z',
  blocks: [LOADED.blocks[0]!, { id: 'ch01#dddd4444', i: 1, text: NEW_TEXT, hash: 'd' }, LOADED.blocks[2]!],
};

const answer = (body: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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

type DrawProps = {
  entry?: CatalogEntry;
  passActive?: boolean;
  fresh?: boolean;
};

/** Mount once, then re-render with the props a frame would bring: the state is kept. */
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
        revision={null}
        revising={null}
        caret={null}
        fresh={props.fresh ?? false}
        passActive={props.passActive}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        history
      />,
    );
  });
  await flush();
  return container;
}

/** The text the paragraph holds right now: its own count, never `textContent` (BOOK-89). */
const chars = (view: HTMLDivElement, id: string): string | null =>
  view.querySelector(`[data-block-id="${id}"]`)?.getAttribute('data-chars') ?? null;

/** What the article shows as text, in characters: it can only grow while a block prints. */
const total = (view: HTMLDivElement): number =>
  [...view.querySelectorAll('[data-block-id]')].reduce((sum, node) => sum + Number(node.getAttribute('data-chars') ?? 0), 0);

/** The block's full length as `data-chars` prints it. */
const full = (index: number): string => String(LOADED.blocks[index]!.text.length);

/** One `pass:stage` frame as the tailer publishes it. */
function stageEvent(stage: string): PassStageEvent {
  return {
    passId: 'pas_01J9Z8K4Q7',
    chapter: 1,
    stageSeq: 1,
    stage: stage as PassStageEvent['stage'],
    at: 1_764_000_000_000,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: 'глава пишется',
    span: null,
    tokens: null,
    costUsd: null,
  } as PassStageEvent;
}

describe('a pass in flight prints the text its refetch brings', () => {
  let frames: FrameRequestCallback[] = [];
  let clock = 0;
  async function tick(ms: number): Promise<void> {
    const next = frames.shift();
    clock += ms;
    await act(async () => next?.(clock));
  }

  beforeEach(() => {
    frames = []; clock = performance.now();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal('IntersectionObserver', EagerObserver);
  });

  it('prints the blocks the pass changed and leaves the untouched paragraphs final', async () => {
    const fetchMock = vi.fn(async () => answer(fetchMock.mock.calls.length === 1 ? LOADED : APPLIED));
    vi.stubGlobal('fetch', fetchMock);
    const view = await draw({ passActive: true });

    // The chapter was written days ago: joining it prints nothing, whatever is in flight.
    expect(total(view)).toBe(LOADED.blocks.reduce((sum, block) => sum + block.text.length, 0));
    expect(view.querySelector('.ch-print')).toBeNull();

    // The catalog drifts by one revision and the article refetches — and the refetch is what
    // the pass left behind. Nothing else says so: no `chapter:revision` frame exists for it.
    await draw({ entry: { ...ENTRY, rev: 2 }, passActive: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const atOnce = total(view);
    expect(chars(view, 'ch01#dddd4444')).toBe('0');
    expect(view.querySelector('[data-block-id="ch01#dddd4444"]')?.className).toContain('is-printing');
    expect(view.querySelector('.ch-print')?.textContent).toBe('■ печатается');
    expect(chars(view, 'ch01#aaaa1111')).toBe(full(0));
    expect(chars(view, 'ch01#cccc3333')).toBe(full(2));

    await tick(250);
    expect(total(view)).toBeGreaterThan(atOnce); // the article grew: the text is being typed
    expect(total(view)).toBeLessThan(atOnce + NEW_TEXT.length);

    for (let step = 0; step < 12; step += 1) await tick(250);
    expect(chars(view, 'ch01#dddd4444')).toBe(String(NEW_TEXT.length));
    expect(view.querySelector('.ch-print')).toBeNull();
  });

  it('replaces the chapter whole when no pass is in flight — the machine path', async () => {
    const fetchMock = vi.fn(async () => answer(fetchMock.mock.calls.length === 1 ? LOADED : APPLIED));
    vi.stubGlobal('fetch', fetchMock);
    const view = await draw();
    await draw({ entry: { ...ENTRY, rev: 2 } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chars(view, 'ch01#dddd4444')).toBe(String(NEW_TEXT.length));
    expect(view.querySelector('.ch-print')).toBeNull();
  });

  it('a `landed` stage clears the flag, so the refetch after it does not print', async () => {
    let passes: Passes = applyStage({}, stageEvent('drafting'));
    const fetchMock = vi.fn(async () => answer(fetchMock.mock.calls.length === 1 ? LOADED : APPLIED));
    vi.stubGlobal('fetch', fetchMock);
    const view = await draw({ passActive: passes[1] !== undefined });

    // The tailer publishes `landed`: the pass is over, whatever the page does next.
    passes = applyStage(passes, stageEvent('landed'));
    expect(passes[1]).toBeUndefined();
    await draw({ entry: { ...ENTRY, rev: 2 }, passActive: passes[1] !== undefined });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chars(view, 'ch01#dddd4444')).toBe(String(NEW_TEXT.length));
    expect(view.querySelector('.ch-print')).toBeNull();
  });

  it('a first load during a pass keeps the `fresh` path: the chapter arrives, it does not change', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(LOADED)));
    const view = await draw({ passActive: true, fresh: true });

    // `live`: the chapter is new to the reader, so its opening prints from the first character.
    expect(chars(view, 'ch01#aaaa1111')).toBe('0');
    for (let step = 0; step < 12; step += 1) await tick(250);
    expect(chars(view, 'ch01#aaaa1111')).toBe(full(0));
  });
});
