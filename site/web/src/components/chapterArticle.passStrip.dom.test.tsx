// @vitest-environment jsdom
import type { BlockRevisingPayload, CatalogEntry, ChapterDto, PassStage, PassStageEvent, StageSpan } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { closePassStrip, openPassStrip } from '../lib/usePassStrip.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-167 — a pass on the page: the block it writes and the strip under it.
 *
 * The harness is `chapterArticle.pass.dom.test.tsx`'s (eager observer, reduced-motion stub,
 * frames pulled by hand), plus what the live renderer itself needs: a line box and boxes for
 * its run, because jsdom lays nothing out.
 *
 * What this proves: a `typing`/`landed` stage mounts `LivePass` for the block its span names;
 * the strip opens on that block and reads `печатается`; with no pass neither exists; and a
 * reader who arrives after the pass is over gets the settled text with no carets at all.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const START = Date.now();
const BEFORE = 'Второй абзац до подхода писателя.';
const AFTER = 'Второй абзац, переписанный на ходу.';

const SPAN: StageSpan[] = [{ blockId: 'ch01#bbbb2222', before: BEFORE, after: AFTER, truncated: false }];

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
  n: 1, title: null, rev: 1, chars: 85, basis: false,
  writtenAt: '2026-10-20T09:20:00Z', updatedAt: '2026-10-20T09:20:00Z',
  blocks: [
    { id: 'ch01#aaaa1111', i: 0, text: 'Первый абзац стоит на месте.', hash: 'a' },
    { id: 'ch01#bbbb2222', i: 1, text: BEFORE, hash: 'b' },
    { id: 'ch01#cccc3333', i: 2, text: 'Третий абзац стоит на месте.', hash: 'c' },
  ],
};

/** The chapter after the pass: the written block is new text, and therefore a new id. */
const APPLIED: ChapterDto = {
  ...LOADED, rev: 2, chars: 100,
  blocks: [LOADED.blocks[0]!, { id: 'ch01#dddd4444', i: 1, text: AFTER, hash: 'd' }, LOADED.blocks[2]!],
};

function event(stage: PassStage, seq: number, overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 1,
    stageSeq: seq,
    stage,
    at: START,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: `строка ${String(seq)}`,
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

const LEAD: PassStageEvent[] = [
  event('queued', 1, { at: START - 4_000 }),
  event('read', 2, { at: START - 3_000, summary: 'читает главу 1' }),
  event('landed', 3, { at: START, span: SPAN }),
  event('typing', 4, { at: START }),
];

/** One `block:revising` payload: the pass's own mark, and with it `#pass`. */
function livePass(): BlockRevisingPayload {
  return {
    n: 1,
    active: true,
    blockIds: ['ch01#bbbb2222'],
    cause: 'draft',
    changeId: 'chg_1',
    lane: 'forward',
    since: '2026-10-25T09:20:00Z',
    expiresAt: '2026-10-25T09:40:00Z',
  };
}

const answer = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

const LINE = 30.24;
const rect = (top: number, left: number, width: number, height: number): DOMRect =>
  ({ top, left, width, height, bottom: top + height, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  closePassStrip();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  // No frame is pulled: the pass is mounted, its ink is pending, and that is the assertion.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: `${LINE}px` } as CSSStyleDeclaration);
  // jsdom lays nothing out: the block and its graphemes get boxes the engine accepts.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('p-pass')) return rect(0, 0, 342, LINE * 3);
    const index = Number(this.getAttribute('data-i') ?? '-1');
    if (index < 0) return rect(0, 0, 0, 0);
    return rect(Math.floor(index / 20) * LINE, 8 + (index % 20) * 12, 12, LINE);
  });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/stages')) return answer({ stages: [] });
    return answer(url.includes('/api/chapters/1') ? LOADED : { code: 'NOT_FOUND' });
  }));
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => {
      closePassStrip();
      root?.unmount();
    });
  } else {
    closePassStrip();
  }
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

async function draw({
  stages,
  revising = livePass(),
  chapter = LOADED,
}: {
  stages?: readonly PassStageEvent[];
  revising?: BlockRevisingPayload | null;
  chapter?: ChapterDto;
} = {}): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/stages')) return answer({ stages: [] });
    return answer(chapter);
  }));
  await act(async () => {
    root?.render(
      <ChapterArticle
        entry={ENTRY}
        revision={null}
        revising={revising}
        caret={null}
        fresh={false}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        history
        stages={stages}
      />,
    );
  });
  await flush();
  return container!;
}

describe('a typing stage paints its block and opens the strip', () => {
  it('renders the live renderer for the block the span names, from the event’s own moment', async () => {
    const view = await draw({ stages: LEAD });
    const pass = view.querySelector('[data-block-id="ch01#bbbb2222"]') as HTMLElement | null;
    expect(pass?.className).toContain('p-pass');
    expect(pass?.getAttribute('data-pass')).not.toBeNull();
    // The span's own text, painted in place: the page has not refetched and does not have to.
    expect(pass?.querySelector('.pass-visual')?.textContent).toBe(AFTER);
    // The renderer is mounted, so its carets are there — one of each.
    expect(view.querySelectorAll('.caret-read')).toHaveLength(1);
    expect(view.querySelectorAll('.caret-write')).toHaveLength(1);
  });

  it('opens the strip on the live block, right after the paragraph, reading «печатается»', async () => {
    const view = await draw({ stages: LEAD });
    expect(view.querySelector('.pass-strip')).toBeNull();
    await act(async () => {
      openPassStrip({ chapter: 1, blockId: 'ch01#bbbb2222' });
    });
    const strip = view.querySelector('.pass-strip');
    expect(strip).not.toBeNull();
    // A block sibling after the paragraph, in the seam's place — never inside the <p>.
    const pass = view.querySelector('[data-block-id="ch01#bbbb2222"]');
    expect(pass?.nextElementSibling).toBe(strip);
    expect(strip?.closest('p')).toBeNull();
    expect(strip?.querySelector('[data-row="landed"]')?.textContent).toContain('печатается');
    expect(strip?.textContent).toContain('книга пишется');
    // The nav's anchor still names the block the door opened.
    expect(view.querySelector('#pass')?.getAttribute('data-pass-block')).toBe('ch01#bbbb2222');
  });
});

describe('no pass, no surface', () => {
  it('mounts neither the renderer nor the strip when no stage concerns the chapter', async () => {
    const view = await draw();
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.querySelector('.pass-strip')).toBeNull();
    // The ordinary paragraph is there, in the ordinary element.
    expect(view.querySelectorAll('[data-block-id]')).toHaveLength(3);

    await act(async () => {
      openPassStrip({ chapter: 1, blockId: 'ch01#bbbb2222' });
    });
    // The strip's one read answers outside the click: let it land inside `act`.
    await flush();
    expect(view.querySelector('.pass-strip')).not.toBeNull();
    await act(async () => {
      closePassStrip();
    });
    expect(view.querySelector('.pass-strip')).toBeNull();
  });
});

describe('a refetched block', () => {
  it('keeps the strip with the pass when the block it was opened on is gone', async () => {
    const view = await draw({ stages: LEAD });
    await act(async () => {
      openPassStrip({ chapter: 1, blockId: 'ch01#gone00000' });
    });
    await flush();
    // The target block does not exist: the strip is placed after the chapter's last paragraph,
    // never dropped and never duplicated.
    const strips = view.querySelectorAll('.pass-strip');
    expect(strips).toHaveLength(1);
    expect(strips[0]?.previousElementSibling?.getAttribute('data-block-id')).toBe('ch01#cccc3333');
  });
});

describe('the late reader', () => {
  it('gets the settled text and no carets — never a replay', async () => {
    const late = [
      event('read', 1, { at: START - 120_000 }),
      event('landed', 2, { at: START - 90_000, span: SPAN }),
      event('typing', 3, { at: START - 90_000 }),
    ];
    const view = await draw({ stages: late, chapter: APPLIED });
    // The chapter already carries what the pass wrote: the paragraph is an ordinary one.
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.querySelector('.caret-read')).toBeNull();
    expect(view.querySelector('.caret-write')).toBeNull();
    const block = view.querySelector('[data-block-id="ch01#dddd4444"]');
    expect(block?.textContent).toContain(AFTER);
  });
});
