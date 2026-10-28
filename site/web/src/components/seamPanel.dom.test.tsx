// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { hideRevision } from '../lib/useRevision.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-111 (owner, 2026-10-27) — «Два поповера, нужно чтобы был один или поменялся контекст в
 * существующем», and BOOK-128 comment #3815 — the word's record is **marginalia**, not a panel.
 *
 * What stands after both: the page has one floating frame, and it is a **filing card**. The
 * word's facts are the strip's own body (no close, no CTA, no z-index), so the strip cannot be
 * collapsed by them; a card opened from the strip still takes the strip to its one line, so
 * exactly one ✕ stands on the page whatever the reader opened.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 8,
  part: 2,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 40,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const BLOCK_ID = 'ch08#onebox1';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
/** The seam opens on the first sentence: this is the quote the strip speaks about. */
const SEAM_QUOTE = 'Я вошёл в пустую комнату.';

/** Every close the page can carry: exactly one may stand at a time. */
const CLOSES = '.seam-close, .prov-close, .filing-close, .revision-close, .focus-exit';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: SEAM_QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    attempt: null,
    frame: null,
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    hideFiling();
    hideRevision();
    closeSeam();
  });
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  resetParagraphChainCache();
});

async function renderParagraph(comments: readonly CommentDto[], history: boolean): Promise<void> {
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        blockCount={40}
        comments={comments}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history={history}
      />,
    );
  });
}

async function mount({
  comments = [] as readonly CommentDto[],
  history = true,
}: { comments?: readonly CommentDto[]; history?: boolean } = {}): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
  await renderParagraph(comments, history);
  await act(async () => {
    openSeam({ chapter: 8, blockId: BLOCK_ID, key: seamKey(8, BLOCK_ID, anchor!.sentence, ENTRY.rev), anchor, origin: container });
  });
}

/** A click plus the promise turns a handler (the chain read) needs inside the same `act`. */
async function click(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  await act(async () => {
    element.click();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

const seam = (): HTMLElement => document.querySelector<HTMLElement>('.seam') as HTMLElement;

describe('the word’s record is the strip’s body, never a second box', () => {
  it('opens under the row and keeps the strip, its ✕ and its action exactly where they were', async () => {
    await mount();
    expect(seam().getAttribute('data-state')).toBe('strip');
    const row = seam().querySelector('.seam-row');
    const beforeText = row?.textContent ?? '';
    const beforeControls = row?.querySelectorAll('button, a').length ?? 0;

    await click('.seam-prov');

    // The one floating frame count is 0: the block is in the page's flow / margin, not above it.
    expect(document.querySelectorAll('.prov-panel, .filing-panel')).toHaveLength(0);
    const block = document.querySelector<HTMLElement>('.prov-block');
    expect(block, 'the facts are the strip’s own body').not.toBeNull();
    expect(seam().contains(block)).toBe(true);
    // The row is untouched: the same node, the same words, the same controls — only the door's
    // `aria-expanded` (and its ink, in CSS) says the body under it is open.
    expect(seam().querySelector('.seam-row')).toBe(row);
    expect(seam().querySelector('.seam-row')?.textContent).toBe(beforeText);
    expect(seam().querySelector('.seam-row')?.querySelectorAll('button, a')).toHaveLength(beforeControls);
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(document.querySelector(CLOSES)?.className).toBe('seam-close');
    // The paragraph behind is untouched and the strip is still its block sibling (§2.1, BOOK-68).
    expect(document.querySelector<HTMLElement>('.p')?.textContent).toContain(TEXT);
    expect(document.querySelector<HTMLElement>('.p')?.nextElementSibling).toBe(seam());

    // Closing it gives focus to the door, and the strip's own rows are still there.
    await click('.seam-prov');
    expect(document.querySelector('.prov-block')).toBeNull();
    expect(document.activeElement).toBe(seam().querySelector('.seam-prov'));
    expect(seam().querySelector('.seam-cta')).not.toBeNull();
  });

  it('a filing card opened from the strip collapses the strip to one line — one close stays', async () => {
    await mount({ comments: [comment()] });
    await click('.seam-filing');

    expect(document.querySelector('.filing-panel')).not.toBeNull();
    // BOOK-128 §1 survives for the card: the strip is the same place, one line, no ✕ of its own.
    expect(seam().getAttribute('data-state')).toBe('card');
    expect(seam().textContent).toBe('«Я» · глава 08 · замечание №4Q7');
    expect(seam().querySelector('.seam-close')).toBeNull();
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(document.querySelector(CLOSES)?.className).toBe('filing-close');

    await click('.filing-close');
    expect(document.querySelector('.filing-panel')).toBeNull();
    expect(seam().querySelector('.seam-filing')).not.toBeNull();
    expect(document.activeElement).toBe(seam().querySelector('.seam-filing'));
  });

  it('the card raised by the word’s own line three keeps the strip and floats alone', async () => {
    await mount({ comments: [comment()] });
    await click('.seam-prov');

    const door = document.querySelector<HTMLAnchorElement>('.prov-door');
    expect(door?.textContent).toBe('№4Q7 · ждёт');
    await act(async () => {
      door?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    });

    const card = document.querySelector<HTMLElement>('.filing-panel');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('в комнате должен быть свет, но не от лампы');
    // The strip is the collapsed line (a card opened from it), and the card is the one close.
    expect(seam().getAttribute('data-state')).toBe('card');
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(document.querySelector(CLOSES)?.className).toBe('filing-close');
  });

  it('a panel opened from a mark closes the seam', async () => {
    await mount({ comments: [comment({ anchor: { ...comment().anchor, quote: 'Её освещал яркий свет.' } })] });
    expect(seam()).not.toBeNull();

    await click('.filing-mark');

    // One floating frame and nothing inline beside it: the strip is not a second place here.
    expect(document.querySelector('.filing-panel')).not.toBeNull();
    expect(document.querySelector('.seam')).toBeNull();
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
  });
});

describe('the strip gets its rows and its focus back', () => {
  it('hands focus to its own action when the door is gone', async () => {
    // The row that opened the card can leave the feed while the card is open (a refresh, a
    // hidden filing). Its door cannot receive focus then — and the reader must not land on
    // `<body>`, so the strip's own action takes it.
    await mount({ comments: [comment()] });
    await click('.seam-filing');
    expect(document.querySelector('.filing-panel')).not.toBeNull();

    await renderParagraph([], true);
    await click('.filing-close');

    expect(document.querySelector('.filing-panel')).toBeNull();
    expect(seam().querySelector('.seam-filing')).toBeNull();
    // The fallback selector's first match in document order: the strip's word door.
    expect(document.activeElement).toBe(seam().querySelector('.seam-prov'));
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe('the card is placed inside the visual viewport (BOOK-137)', () => {
  it('applies the visual viewport’s offsets, not the layout window’s zeros', async () => {
    // A phone with the URL bar showing: the visible box starts 120 px down and is 640 tall,
    // while `window.innerHeight` still reports the whole layout viewport.
    vi.stubGlobal('visualViewport', { width: 390, height: 640, offsetLeft: 0, offsetTop: 120 });

    await mount({ comments: [comment()] });
    await click('.seam-filing');

    const panel = document.querySelector<HTMLElement>('.filing-panel');
    expect(panel).not.toBeNull();
    // jsdom's ink has no layout: the anchor is at 0 and the card is empty, so its own height is
    // 0 — the placement is the box's margin, counted from the visible viewport's top.
    expect(panel?.style.top).toBe('132px');
    expect(panel?.style.left).toBe('12px');
    expect(panel?.style.width).toBe('366px');
    expect(Number.parseFloat(panel?.style.maxHeight ?? '0')).toBeLessThanOrEqual(640 - 2 * 12);
  });
});

describe('nothing in the word’s layer owns a close, an action or a frame', () => {
  it('renders no button and no close inside the block', async () => {
    await mount();
    await click('.seam-prov');

    const block = document.querySelector<HTMLElement>('.prov-block');
    expect(block).not.toBeNull();
    for (const gone of ['.prov-close', 'button', '[role="dialog"]', '.prov-action', '.prov-rules']) {
      expect(block?.querySelector(gone), gone).toBeNull();
    }
    // And the CTA the panel used to carry is not anywhere in the strip either.
    expect(seam().textContent).not.toContain('вмешаться здесь');
    expect(seam().textContent).not.toContain('что это значит');
    expect(document.body.textContent).not.toContain('вмешаться здесь');
  });

  it('asks nothing at all with history off, and renders no door to the empty room', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await mount({ history: false });

    // No door to an empty room: neither the word's side of the strip nor the phrase's `⋯`.
    expect(seam().querySelector('.seam-prov')).toBeNull();
    expect(document.querySelector('.prov')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
