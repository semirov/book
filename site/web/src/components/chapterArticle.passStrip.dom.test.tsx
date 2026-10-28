// @vitest-environment jsdom
import type { BlockRevisingPayload, CatalogEntry, ChapterDto, PassStage, PassStageEvent, StageSpan } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { closePassStrip, currentPassStrip, openPassStrip } from '../lib/usePassStrip.ts';
import { ChapterArticle } from './ChapterArticle.tsx';
import { FootJumps } from './FootJumps.tsx';

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
  vi.useRealTimers();
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

describe('a pass with no revising payload', () => {
  it('carries #pass on the block it paints, and the foot’s door opens the strip through it', async () => {
    vi.useFakeTimers();
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 0 });
    const view = await draw({ stages: LEAD, revising: null });

    // The server emits no `block:revising` for a pass: the anchor follows the painted block.
    const anchor = view.querySelector('#pass');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('data-pass-block')).toBe('ch01#bbbb2222');
    expect(anchor?.nextElementSibling).toBe(view.querySelector('[data-block-id="ch01#bbbb2222"]'));
    expect(currentPassStrip()).toBeNull();

    // The grip's third item is on the same page: `#pass` is the only way into the strip.
    // `getComputedStyle` is the article harness's stub plus the token read the grip's own offset
    // needs (`--offset-top`); the fallback of 64 px is what the assertion below reads.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      lineHeight: `${LINE}px`,
      getPropertyValue: () => '',
    } as unknown as CSSStyleDeclaration);
    const footContainer = document.body.appendChild(document.createElement('div'));
    const footRoot = createRoot(footContainer);
    try {
      await act(async () => {
        footRoot.render(<FootJumps live processing revising={false} chapter={1} change={null} plate={false} />);
      });
      const door = footContainer.querySelector('.foot-jump-pass') as HTMLAnchorElement;
      expect(door.getAttribute('href')).toBe('#pass');

      await act(async () => {
        door.click();
      });
      // The strip opens on the block the page named, before any cut.
      expect(currentPassStrip()).toEqual({ chapter: 1, blockId: 'ch01#bbbb2222' });
      await flush();
      expect(view.querySelector('.pass-strip')).not.toBeNull();
      expect(view.querySelector('.pass-strip')?.textContent).toContain('печатается');

      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(scrollTo).toHaveBeenCalled();
    } finally {
      await act(async () => {
        footRoot.unmount();
      });
      footContainer.remove();
    }
  });
});

describe('a typing frame after the landing', () => {
  let queue: FrameRequestCallback[] = [];
  let clock = 0;

  beforeEach(() => {
    queue = [];
    clock = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queue.push(callback);
      return queue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  /** Pull the frame that is due `ms` after the previous one. */
  async function step(ms: number): Promise<void> {
    clock += ms;
    const next = queue.shift();
    await act(async () => {
      next?.(clock);
    });
  }

  /** Twelve frames: the pass is over, its ink on the page, its carets gone. */
  async function settlePass(): Promise<void> {
    for (let index = 0; index < 12; index += 1) await step(250);
  }

  it('does not re-type or remount a paragraph it already inked', async () => {
    const started = Date.now();
    const landedOnly = [
      event('read', 1, { at: started - 2_000 }),
      event('landed', 2, { at: started, span: SPAN }),
    ];
    const view = await draw({ stages: landedOnly, revising: null });
    expect(view.querySelector('.p-pass')).not.toBeNull();

    await settlePass();
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.querySelector('.caret-read')).toBeNull();
    expect(view.querySelector('.caret-write')).toBeNull();
    expect(view.querySelector('.pg.is-pending')).toBeNull();
    const settledNode = view.querySelector('[data-block-id="ch01#bbbb2222"]');
    expect(settledNode).not.toBeNull();
    expect(settledNode?.classList.contains('p-pass')).toBe(false);

    // The real order: the tailer stores the landing, then `typing` above it (max seq + 1). The
    // same pass must not be a new renderer — no caret, no pending ink, no second mount.
    await draw({ stages: [...landedOnly, event('typing', 3, { at: started + 400 })], revising: null });
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.querySelector('.caret-read')).toBeNull();
    expect(view.querySelector('.caret-write')).toBeNull();
    expect(view.querySelector('.pg.is-pending')).toBeNull();
    expect(view.querySelector('[data-block-id="ch01#bbbb2222"]')).toBe(settledNode);
  });

  it('starts one renderer whichever of the two stages the page saw last', async () => {
    const started = Date.now();
    // `typing` with a lower seq: the pass is painted from the landing's own moment, once.
    const typingFirst = [
      event('typing', 1, { at: started - 5_000 }),
      event('landed', 2, { at: started, span: SPAN }),
    ];
    const view = await draw({ stages: typingFirst, revising: null });
    expect(view.querySelector('.p-pass')).not.toBeNull();
    expect(view.querySelector('.pg.is-pending')).not.toBeNull();

    await settlePass();
    const settledNode = view.querySelector('[data-block-id="ch01#bbbb2222"]');
    expect(view.querySelector('.p-pass')).toBeNull();

    // A later typing on the same pass is a no-op, not a second animation.
    await draw({ stages: [...typingFirst, event('typing', 3, { at: started + 400 })], revising: null });
    expect(view.querySelector('.p-pass')).toBeNull();
    expect(view.querySelector('.caret-read')).toBeNull();
    expect(view.querySelector('[data-block-id="ch01#bbbb2222"]')).toBe(settledNode);
  });
});
