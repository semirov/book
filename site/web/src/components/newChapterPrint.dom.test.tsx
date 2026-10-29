// @vitest-environment jsdom
import type { CatalogEntry, ChapterDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppliedRecord } from '../lib/appliedPrint.ts';
import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-220 §11.2 — a chapter being written prints from its first character, on the one clock.
 *
 * The slot a reader sees before the ink is a **head and a title**: the numeral, the chapter's
 * title, and no skeleton. The prose then arrives per character on the print engine's schedule
 * (30 cps desk / 26 phone, seeded, no cap), in document order — the title is ahead of the first
 * paragraph, not after it — and a page that mounts inside the print joins the current frame
 * instead of replaying it from zero.
 *
 * jsdom lays nothing out and has no clock: `requestAnimationFrame` is a queue and
 * `performance.now` a knob, exactly as in the other print tests.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Comes into view at once: the prose is fetched and the print starts. */
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

const FIRST = 'Она вошла в комнату и поставила на стол папку с бумагами, которых я ждал.';
const SECOND = 'Потом она села напротив и стала ждать, пока я прочитаю первую страницу.';

const ENTRY: CatalogEntry = {
  n: 7,
  part: 1,
  title: null,
  rev: 0,
  chars: 0,
  blocks: 0,
  written: false,
  basis: false,
  opening: null,
  writtenAt: null,
  updatedAt: null,
  direction: 'forward',
};

const CHAPTER: ChapterDto = {
  n: 7,
  title: 'Новая глава',
  rev: 1,
  chars: FIRST.length + SECOND.length,
  basis: false,
  writtenAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  blocks: [
    { id: 'ch07#aaaa1111', i: 0, text: FIRST, hash: 'a' },
    { id: 'ch07#bbbb2222', i: 1, text: SECOND, hash: 'b' },
  ],
};

function appliedNow(offsetMs = 0): AppliedRecord {
  return {
    n: 7,
    rev: 1,
    appliedAt: Date.now() - offsetMs,
    patch: [],
    patchTruncated: false,
    span: null,
  };
}

const answer = (body: unknown): Response => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let frames: FrameRequestCallback[] = [];
let clock = 0;

beforeEach(() => {
  frames = [];
  clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ lineHeight: '24px' } as CSSStyleDeclaration);
});

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

async function step(ms: number): Promise<void> {
  const next = frames.shift();
  clock += ms;
  await act(async () => next?.(clock));
}

async function draw(applied: AppliedRecord): Promise<HTMLDivElement> {
  vi.stubGlobal('fetch', vi.fn(async () => answer(CHAPTER)));
  if (container === null) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(
      <ChapterArticle
        entry={ENTRY}
        revision={null}
        revising={null}
        caret={null}
        fresh={false}
        applied={applied}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: false, displayName: null }}
        history
      />,
    );
  });
  await flush();
  return container;
}

const paragraph = (view: HTMLElement, index = 0): HTMLParagraphElement | null =>
  view.querySelectorAll<HTMLParagraphElement>('p[data-block-id]')[index] ?? null;
const chars = (node: HTMLElement | null): number => Number(node?.getAttribute('data-chars') ?? '-1');

describe('the slot before the print', () => {
  it('shows the chapter’s number and title, and no skeleton', async () => {
    const view = await draw(appliedNow());
    expect(view.querySelector('.ch-n')?.textContent).toBe('07');
    expect(view.querySelector('.ch-title')?.textContent).toBe('Новая глава');
    expect(view.querySelector('.skel')).toBeNull();
    expect(view.querySelector('.ch-placeholder')).toBeNull();
    // And nothing is inked yet: the prose is a block of zero characters.
    expect(chars(paragraph(view))).toBe(0);
  });

  it('puts the title before the prose in document order, never after it', async () => {
    const view = await draw(appliedNow());
    const title = view.querySelector('.ch-title');
    const first = paragraph(view);
    if (title === null || first === null) throw new Error('the slot has no head or no prose');
    // `compareDocumentPosition` bit 4: the title follows the head and precedes the prose.
    expect(first.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(title.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the chapter prints on the print clock', () => {
  it('reveals from character 0, monotonically, at the device rate', async () => {
    const view = await draw(appliedNow());
    const block = paragraph(view);
    expect(chars(block)).toBe(0);
    const seen: number[] = [0];
    for (let index = 0; index < 12; index += 1) {
      await step(100);
      seen.push(chars(paragraph(view)));
    }
    expect(seen.every((value, index) => index === 0 || value >= (seen[index - 1] ?? -1))).toBe(true);
    expect(seen.at(-1) ?? 0).toBeGreaterThan(5);
    // 1 200 ms at 30 cps (hold 220 ms included) is ≈ 29 graphemes; hesitations and word ends
    // only ever make it slower, so the bound below is the rate, not a curve.
    expect(seen.at(-1) ?? 0).toBeGreaterThan(18);
    expect(seen.at(-1) ?? 0).toBeLessThan(31);
    // One caret, on the printing paragraph.
    expect(view.querySelectorAll('.caret-inline')).toHaveLength(1);
  });

  it('ends on the revision’s own text: the block is the final one, id and all', async () => {
    const view = await draw(appliedNow());
    for (let index = 0; index < 40; index += 1) await step(400);
    const block = paragraph(view);
    expect(block?.getAttribute('data-block-id')).toBe('ch07#aaaa1111');
    // `data-chars` is the printed length (BOOK-89); the element also carries the paragraph's
    // chrome (the seam door), so the text is checked by containment, the count by the number.
    expect(chars(block)).toBe(FIRST.length);
    expect(block?.textContent).toContain(FIRST);
    // The chapter's whole prose is set, and no caret is left standing.
    expect(paragraph(view, 1)?.textContent).toContain(SECOND);
    expect(view.querySelectorAll('.caret-inline')).toHaveLength(0);
  });

  it('a page that mounts mid-print joins the current frame, not character 0', async () => {
    const view = await draw(appliedNow(1_500));
    const block = paragraph(view);
    const shown = chars(block);
    expect(shown).toBeGreaterThan(10);
    expect(shown).toBeLessThan(FIRST.length);
    // The ink is where the clock says: 1 500 ms of 30 cps minus the hold ≈ 38 characters.
    expect(shown).toBeGreaterThan(25);
    expect(shown).toBeLessThan(45);
  });
});
