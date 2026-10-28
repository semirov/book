// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { anchorFor, seamKey } from '../lib/seam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { hideRevision } from '../lib/useRevision.ts';
import { closeSeam, openSeam } from '../lib/useSeam.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-111 (owner, 2026-10-27) — the overlay on a thumb.
 *
 * A tap outside an open seam must change nothing on a touch surface: only its own ✕, a
 * successful submit or `Escape` from a keyboard closes it. A scroll is not a tap on any
 * device, a fine pointer keeps the desktop behaviour, and two half-written surfaces never
 * coexist — the page holds one seam and one panel at a time.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

function entryFor(n: number): CatalogEntry {
  return {
    n,
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
}

function comment(blockId: string, overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId, blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    premise: false,
    reason: null,
    refusal: null,
    attempt: null,
    frame: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

/** A coarse pointer at a phone's width — the device the owner's rule is written for. */
function touchDevice(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

/** A fine pointer at a desktop's width: the behaviour that must not regress. */
function desktopDevice(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
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
}

function pointer(type: string, target: EventTarget, x: number, y: number, pointerId = 1): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId }));
}

/** One press, one release, no travel: a tap. */
function tap(target: EventTarget, x = 5, y = 5): void {
  pointer('pointerdown', target, x, y);
  pointer('pointerup', target, x, y);
}

/** A press, 40 px of travel and a release: a scroll, which is not a tap. */
function scroll(target: EventTarget, x = 5, y = 5): void {
  pointer('pointerdown', target, x, y);
  pointer('pointermove', target, x, y + 40);
  pointer('pointerup', target, x, y + 40);
}

/** A controlled field needs the native setter, or React never sees the change. */
function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.unstubAllGlobals();
});

/** The paragraph, with its seam open at its first sentence — the strip a reader can grow. */
async function mountParagraph(blockId: string, comments: readonly CommentDto[] = [], onPosted: () => void = () => undefined): Promise<void> {
  const entry = entryFor(8);
  const anchor = anchorFor({ text: TEXT, blockId, baseRev: entry.rev, offset: 0 });
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={entry}
        blockId={blockId}
        blockIndex={0}
        baseRev={entry.rev}
        text={TEXT}
        blockCount={40}
        comments={comments}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={onPosted}
        history
      />,
    );
  });
  await act(async () => {
    openSeam({ chapter: 8, blockId, key: seamKey(8, blockId, anchor!.sentence, entry.rev), anchor, origin: container });
  });
}

const seam = (): HTMLElement | null => document.querySelector<HTMLElement>('.seam');
/** BOOK-128 #3852 — one block of either surface: the record is the strip's successor. */
const anyBlock = (): Element[] => [...document.querySelectorAll('.seam, .rec')];
const openForm = async (): Promise<void> => {
  await act(async () => (document.querySelector('.seam-cta, .rec-cta') as HTMLElement).click());
};

describe('a thumb on the page (BOOK-111)', () => {
  it('at 390 with a coarse pointer an outside tap leaves the open form alone', async () => {
    touchDevice();
    const posted = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            comment: comment('ch08#touch01', { id: 'cmt_01M5Z8HKWHPHZQDHP5MCXS5RB4' }),
            remaining: { perHour: 10, remaining: 9, resetAt: null, editsPerDay: 1, editsRemaining: 1, editsResetAt: null },
            queue: { depth: 0 },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await mountParagraph('ch08#touch01', [], posted);
    await openForm();
    typeInto('textarea.seam-text', 'Свет был включён до меня.');

    // A thumb in the middle of the paragraph: the form and its draft stay, character for character.
    await act(async () => tap(document.querySelector('.p') as HTMLElement));
    expect(seam()?.getAttribute('data-open')).toBe('true');
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe('Свет был включён до меня.');

    // The ✕ is the reader's own way out, and it is the only one on the page.
    await act(async () => (document.querySelector('.seam-close') as HTMLElement).click());
    expect(seam()).toBeNull();

    // Sending: the form closes, the receipt is the fact and it stays.
    const again = anchorFor({ text: TEXT, blockId: 'ch08#touch01', baseRev: 3, offset: 0 });
    await act(async () => {
      openSeam({ chapter: 8, blockId: 'ch08#touch01', key: seamKey(8, 'ch08#touch01', again!.sentence, 3), anchor: again, origin: container });
    });
    // Closing the strip is not cancelling the thought: the draft is where it was left.
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe('Свет был включён до меня.');
    await act(async () => {
      document.querySelector('.seam-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector('.seam-form')).toBeNull();
    expect(document.querySelector('.seam-receipt')?.textContent).toContain('зарегистрировано');
    expect(document.querySelector('.seam-receipt')?.textContent).toContain('ждёт');
    expect(posted).toHaveBeenCalledTimes(1);
    // The receipt survives a graze: it is a fact, not a toast.
    await act(async () => tap(document.querySelector('.p') as HTMLElement));
    expect(document.querySelector('.seam-receipt')?.textContent).toContain('зарегистрировано');
  });

  it('a scroll never closes an overlay', async () => {
    await mountParagraph('ch08#scroll1');
    await openForm();
    // A two-finger scroll on a phone: 40 px of travel between press and release.
    touchDevice();
    await act(async () => scroll(document.querySelector('.p') as HTMLElement));
    expect(seam()?.getAttribute('data-open')).toBe('true');

    // The same gesture from a trackpad on a fine pointer: still not a click.
    desktopDevice();
    await act(async () => scroll(document.querySelector('.p') as HTMLElement));
    expect(seam()?.getAttribute('data-open')).toBe('true');
  });

  it('at 1440 with a fine pointer an outside click still closes', async () => {
    desktopDevice();
    await mountParagraph('ch08#mouse01');
    await openForm();
    expect(seam()?.getAttribute('data-open')).toBe('true');
    await act(async () => tap(document.querySelector('.p') as HTMLElement));
    expect(seam()).toBeNull();
  });

  it('opening a second seam leaves exactly one open form', async () => {
    touchDevice();
    await mountParagraph('ch08#twoseam');
    await openForm();
    typeInto('textarea.seam-text', 'Черновик, который не должен переехать.');
    expect(document.querySelectorAll('.seam')).toHaveLength(1);

    // The reader taps another sentence: that is an explicit act, so the page moves the seam.
    const second = [...document.querySelectorAll<HTMLElement>('.p span[data-s]')].at(-1);
    expect(second).not.toBeUndefined();
    await act(async () => pointer('pointerup', second as HTMLElement, 5, 5));
    // One block, and it is the record of the second sentence — the first draft did not travel.
    expect(anyBlock()).toHaveLength(1);
    expect(document.querySelector('.rec')).not.toBeNull();
    expect(document.querySelector('[data-touch]')?.getAttribute('aria-expanded')).toBe('true');
    await openForm();
    expect(document.querySelectorAll('.rec')).toHaveLength(1);
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe('');
  });

  it('opening a seam closes the panel it replaces', async () => {
    touchDevice();
    await mountParagraph('ch08#replace1', [comment('ch08#replace1')]);
    await act(async () => (document.querySelector('.seam-filing') as HTMLElement).click());
    expect(document.querySelector('.filing-panel')).not.toBeNull();

    // A tap on another sentence is the reader's own act: the strip moves, the panel goes.
    const second = [...document.querySelectorAll<HTMLElement>('.p span[data-s]')].at(-1) as HTMLElement;
    await act(async () => pointer('pointerup', second, 5, 5));
    expect(document.querySelector('.filing-panel')).toBeNull();
    // The tap is an explicit act: the record replaces the card and the strip in one commit.
    expect(anyBlock()).toHaveLength(1);
    expect(document.querySelector('.rec')).not.toBeNull();
  });

  it('a pointerdown inside a filing panel closes nothing', async () => {
    for (const device of [touchDevice, desktopDevice]) {
      device();
      await mountParagraph(`ch08#panel${device === touchDevice ? 1 : 2}`, [
        comment(`ch08#panel${device === touchDevice ? 1 : 2}`),
      ]);
      await openForm();
      // The strip's own row opens the filing panel; the form collapses to the strip behind it.
      await act(async () => (document.querySelector('.seam-filing') as HTMLElement).click());
      const panel = document.querySelector<HTMLElement>('.filing-panel');
      expect(panel).not.toBeNull();
      // One overlay at a time: the card collapsed the form, the strip stays as its anchor.
      expect(seam()?.getAttribute('data-open')).toBe('false');
      expect(document.querySelector('.seam-form')).toBeNull();
      const body = panel?.querySelector('.filing-body') as HTMLElement;
      await act(async () => tap(body));
      // Neither the panel nor the strip behind it was closed by a press inside the panel.
      expect(document.querySelector('.filing-panel')).not.toBeNull();
      expect(seam()).not.toBeNull();
      await act(async () => {
        hideFiling();
        closeSeam();
      });
      await act(async () => root?.unmount());
      container = document.body.appendChild(document.createElement('div'));
      root = createRoot(container);
    }
  });
});
