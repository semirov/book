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
 * существующем».
 *
 * On a frozen word the owner saw the strip and the provenance panel as two boxes with two ✕.
 * The strip and the panel are the same place: a panel opened **from** the strip collapses it to
 * one line, the panel keeps the only close, and closing it gives the rows (and focus) back. One
 * `<aside>` then carries whichever context the reader is reading, so provenance ↔ filing is a
 * turn of the same box, never a third surface.
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

async function mount({
  comments = [] as readonly CommentDto[],
  history = false,
}: { comments?: readonly CommentDto[]; history?: boolean } = {}): Promise<void> {
  const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: 0 });
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        frozen={false}
        comments={comments}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history={history}
      />,
    );
  });
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
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

const seam = (): HTMLElement => document.querySelector<HTMLElement>('.seam') as HTMLElement;

describe('a panel opened from the strip makes the strip its one line', () => {
  it('a provenance panel collapses its strip to one line with a single close', async () => {
    await mount();
    expect(seam().getAttribute('data-state')).toBe('strip');

    await click('.seam-prov');

    const panel = document.querySelector<HTMLElement>('.prov-panel');
    expect(panel, 'the word’s DNA is the one floating frame').not.toBeNull();
    expect(panel?.className).toContain('prov-panel-anchored');
    expect(seam().getAttribute('data-state')).toBe('prov');
    // One line, and it is the whole strip: the word, the chapter, the fact the panel carries.
    expect(seam().textContent).toBe('«Я» · глава 08 · откуда это слово');
    expect(seam().querySelectorAll('.seam-prov-line')).toHaveLength(1);
    expect(seam().children).toHaveLength(2); // the polite live region + the one line
    // No ✕ and no other action in the strip: the panel has the only close on the page.
    expect(seam().querySelector('.seam-close')).toBeNull();
    for (const gone of ['.seam-cta', '.seam-filing', '.seam-more', '.seam-frozen', '.seam-form']) {
      expect(seam().querySelector(gone), gone).toBeNull();
    }
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(document.querySelector(CLOSES)?.className).toBe('prov-close');

    // The paragraph behind is untouched and the strip is still its block sibling (§2.1, BOOK-68).
    const paragraph = document.querySelector<HTMLElement>('.p');
    expect(paragraph?.textContent).toContain(TEXT);
    expect(paragraph?.nextElementSibling).toBe(seam());

    // Closing gives the rows back as they were, and focus returns to the door that asked.
    await click('.prov-close');
    expect(document.querySelector('.prov-panel')).toBeNull();
    expect(seam().getAttribute('data-state')).toBe('strip');
    expect(seam().querySelector('.seam-row')).not.toBeNull();
    expect(seam().querySelector('.seam-cta')).not.toBeNull();
    expect(document.activeElement).toBe(seam().querySelector('.seam-prov'));
  });

  it('a filing opened from the strip collapses the strip too', async () => {
    await mount({ comments: [comment()] });
    await click('.seam-filing');

    expect(document.querySelector('.filing-panel')).not.toBeNull();
    expect(seam().getAttribute('data-state')).toBe('prov');
    expect(seam().textContent).toBe('«Я» · глава 08 · замечание №4Q7');
    expect(seam().querySelector('.seam-close')).toBeNull();
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(document.querySelector(CLOSES)?.className).toBe('filing-close');

    await click('.filing-close');
    expect(document.querySelector('.filing-panel')).toBeNull();
    expect(seam().getAttribute('data-state')).toBe('strip');
    expect(seam().querySelector('.seam-filing')).not.toBeNull();
    expect(document.activeElement).toBe(seam().querySelector('.seam-filing'));
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

describe('one box, two contexts (BOOK-DOC-34 §2.6–§2.7)', () => {
  it('switching context reuses the same panel node and keeps one close', async () => {
    await mount({ comments: [comment()] });
    await click('.seam-prov');

    const before = document.querySelector<HTMLElement>('.prov-panel');
    expect(before).not.toBeNull();
    const placed = before?.style.top ?? '';
    await click('.prov-filing');

    const after = document.querySelector<HTMLElement>('.filing-panel');
    expect(after, 'the filing card is the same box').not.toBeNull();
    // The same DOM node, the same anchor and the same placement: the reader keeps their place.
    expect(after).toBe(before);
    expect(after?.getAttribute('data-context')).toBe('filing');
    expect(after?.style.top).toBe(placed);
    expect(document.querySelector('.prov-panel')).toBeNull();
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(document.querySelectorAll('.filing-close')).toHaveLength(1);
    expect(after?.contains(document.activeElement)).toBe(true);

    // And the way back is the same box again.
    await click('.filing-prov');
    const again = document.querySelector<HTMLElement>('.prov-panel');
    expect(again).toBe(before);
    expect(again?.getAttribute('data-context')).toBe('provenance');
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
    expect(again?.contains(document.activeElement)).toBe(true);
    // The strip stayed collapsed through both turns.
    expect(seam().getAttribute('data-state')).toBe('prov');
  });

  it('the provenance panel offers the sentence’s filing in the same box', async () => {
    // The filing is grouped at the seam's own quote: the strip row and the door name one record.
    await mount({ comments: [comment()] });
    await click('.seam-prov');

    const door = document.querySelector<HTMLElement>('.prov-filing');
    expect(door?.textContent).toBe('замечание №4Q7 →');

    await click('.prov-filing');
    const card = document.querySelector<HTMLElement>('.filing-panel');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('в комнате должен быть свет, но не от лампы');
    expect(card?.textContent).toContain('ждёт');
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
  });

  it('the filing card offers its word’s provenance in the same box', async () => {
    // Opened from the mark, so the word can only come from the filing's own sentence.
    await mount({ comments: [comment({ anchor: { ...comment().anchor, quote: 'Её освещал яркий свет.' } })] });
    await click('.filing-mark');

    const door = document.querySelector<HTMLElement>('.filing-prov');
    expect(door?.textContent).toBe('откуда это слово →');

    await click('.filing-prov');
    const panel = document.querySelector<HTMLElement>('.prov-panel');
    expect(panel).not.toBeNull();
    expect(panel?.querySelector('.prov-word')?.textContent?.startsWith('Её')).toBe(true);
    expect(panel?.querySelector('.prov-chapter')?.textContent).toBe('глава 08');
    expect(panel?.querySelector('.prov-action')?.textContent).toBe('вмешаться здесь');
    expect(document.querySelectorAll(CLOSES)).toHaveLength(1);
  });

  it('Escape closes the panel and restores the strip', async () => {
    await mount();
    await click('.seam-prov');
    expect(document.querySelector('.prov-panel')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(document.querySelector('.prov-panel')).toBeNull();
    expect(seam().getAttribute('data-state')).toBe('strip');
    expect(document.activeElement).toBe(seam().querySelector('.seam-prov'));
  });
});

describe('the card’s way into provenance asks the log the same question', () => {
  function notFound(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('loads the chain from the card exactly as the strip’s own door does', async () => {
    const fetchMock = notFound();
    await mount({ comments: [comment({ anchor: { ...comment().anchor, quote: 'Её освещал яркий свет.' } })], history: true });
    await click('.filing-mark');
    fetchMock.mockClear();

    await click('.filing-prov');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(`/api/history/paragraphs/${encodeURIComponent(BLOCK_ID)}`);
  });

  it('asks nothing at all with history off', async () => {
    const fetchMock = notFound();
    await mount({ comments: [comment()] });
    await click('.seam-filing');
    await click('.filing-prov');

    expect(document.querySelector('.prov-panel')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
