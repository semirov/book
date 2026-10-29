// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { closeRecord, resetRecordMemory } from '../lib/record.ts';
import { closeSeam } from '../lib/useSeam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { ProseParagraph } from './ProseParagraph.tsx';
import { tapAt } from './tap.fixture.ts';

/**
 * BOOK-128 comment #3862 — the owner's phone, twice, as tests.
 *
 * A browser sends one tap as `pointerdown` → `pointerup` → `click`. The paragraph used to open
 * the record on both the release **and** the click, so one tap was two toggles: the block
 * mounted and unmounted in the same gesture, and `вмешаться` could never be reached. These
 * tests send the whole gesture (there is no bare `pointerup` anywhere), walk **every** sentence
 * of a chapter that has a filing, and pin the compensation's two observable ends: the record
 * stays mounted, and the pressed control stays where the finger left it.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENTRY: CatalogEntry = {
  n: 9,
  part: 2,
  title: 'Комната на девятом',
  rev: 1,
  chars: 9_000,
  blocks: 3,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const BLOCKS = [
  { id: 'ch09#b0', text: 'Я вошёл в пустую комнату. Её освещал яркий свет.' },
  { id: 'ch09#b1', text: 'Свет был включён до меня. Об этом никто не говорил.' },
  { id: 'ch09#b2', text: 'Потом я закрыл дверь. Часы шли по кругу.' },
];

const FILING: CommentDto = {
  id: 'cmt_01J9Z8K4Q7',
  number: 1,
  chapter: 9,
  anchor: {
    blockId: 'ch09#b1',
    blockIndex: 1,
    quote: 'Свет был включён до меня.',
    prefix: null,
    suffix: null,
    resolved: true,
  },
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
};

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  resetRecordMemory();
  vi.stubGlobal('IntersectionObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    hideFiling();
    closeSeam();
    closeRecord();
  });
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetParagraphChainCache();
  resetRecordMemory();
});

async function frames(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
    });
  }
}

/** The chapter: three paragraphs, one filing on the second block's first sentence. */
async function mountChapter(comments: readonly CommentDto[] = [FILING]): Promise<void> {
  await act(async () => {
    root?.render(
      <>
        {BLOCKS.map((block, index) => (
          <ProseParagraph
            key={block.id}
            entry={ENTRY}
            blockId={block.id}
            blockIndex={index}
            baseRev={ENTRY.rev}
            text={block.text}
            blockCount={BLOCKS.length}
            comments={comments}
            composer={EMPTY_COMPOSER}
            viewer={{ signedIn: true, displayName: 'Филипп' }}
            onPosted={() => undefined}
            history
          />
        ))}
      </>,
    );
  });
  await frames();
}

const rec = (): HTMLElement | null => document.querySelector<HTMLElement>('.rec');

/** Every sentence of the chapter, in reading order. */
function sentences(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.p [data-s]')];
}

/** One tap by the whole browser gesture. */
async function tap(span: HTMLElement): Promise<void> {
  await act(async () => {
    tapAt(span);
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
  await frames();
}

async function press(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  await act(async () => {
    element.click();
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
  await frames();
}

function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

describe('one tap is one opening (the owner’s phone)', () => {
  it('mounts one record and leaves it mounted: the gesture’s own click does not replay it', async () => {
    await mountChapter();
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(container, { childList: true, subtree: true });

    await tap(sentences()[1] as HTMLElement);
    const opened = rec();
    expect(opened).not.toBeNull();
    expect(opened?.getAttribute('data-acc')).toBe('open');
    expect(document.querySelectorAll('.rec')).toHaveLength(1);
    // The sentence has no filing: the block says so in one line, and `вмешаться` is the act.
    expect(document.querySelector('.rec-empty')?.textContent).toBe('с тех пор её никто не трогал');

    await frames(16); // ~400 ms: the close the double binding used to schedule would have run
    observer.disconnect();
    expect(rec()).toBe(opened);
    expect(document.querySelectorAll('.rec')).toHaveLength(1);
    const removed = changes.some((record) =>
      [...record.removedNodes].some((node) => node instanceof Element && node.matches('.rec')),
    );
    expect(removed).toBe(false);
  });

  it('a second tap within 300 ms is a second open/close, not a zoom', async () => {
    await mountChapter();
    const span = sentences()[1] as HTMLElement;
    await tap(span);
    expect(rec()).not.toBeNull();
    // The second tap starts ~120 ms after the first: still a toggle, and only a toggle.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    await tap(span);
    expect(rec()).toBeNull();
    // A third tap opens it again: the gesture is not swallowed by a time guard.
    await tap(span);
    expect(rec()).not.toBeNull();
  });

  it('a 10 px wobble is a tap, a 40 px drag is the page’s', async () => {
    await mountChapter();
    const span = sentences()[1] as HTMLElement;
    const gesture = async (travel: number): Promise<void> => {
      await act(async () => {
        span.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 4, clientY: 4, pointerId: 1, isPrimary: true }));
        span.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, clientX: 4 + travel, clientY: 4, pointerId: 1, isPrimary: true }),
        );
        span.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, clientX: 4 + travel, clientY: 4, pointerId: 1, isPrimary: true }),
        );
        span.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 4 + travel, clientY: 4, detail: 1 }));
      });
      await frames();
    };
    await gesture(10);
    expect(rec()).not.toBeNull();
    await press('.rec-close');
    await frames(8);
    await gesture(40);
    expect(rec()).toBeNull();
  });

  it('a tap on the page’s foot is the foot’s own act, never a record', async () => {
    await mountChapter();
    const foot = document.createElement('nav');
    foot.className = 'foot-jumps';
    foot.innerHTML = '<div class="canvas"><div class="page foot-jumps-in"><button class="foot-jumps-open">оглавление</button></div></div>';
    document.body.appendChild(foot);
    const word = foot.querySelector<HTMLElement>('button') as HTMLElement;
    await tap(word);
    expect(rec()).toBeNull();
    // The prose never contains the band: its controls are siblings, so no prose tap can be
    // swallowed by the foot's hit area (the geometry is `scripts/record-tap.mjs` case 5).
    expect(document.querySelector('.p')?.contains(foot)).toBe(false);
  });
});

describe('вмешаться is one act (the owner’s phone)', () => {
  it('opens the form in the same block and focuses the first field', async () => {
    await mountChapter();
    await tap(sentences()[1] as HTMLElement);
    const block = rec();
    await act(async () => {
      document.querySelector<HTMLElement>('.rec-cta')?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(rec()).toBe(block);
    expect(rec()?.getAttribute('data-body')).toBe('form');
    const form = document.querySelector<HTMLFormElement>('form[data-form]');
    expect(form).not.toBeNull();
    expect(document.activeElement).toBe(form?.querySelector('input.seam-input'));
    expect(document.querySelector('.rec-act-word')?.textContent).toBe('вмешаться');
  });

  it('a sentence without a filing in a paragraph that has one opens its own form, not a notice', async () => {
    await mountChapter();
    // Block 1 holds the filing on its first sentence; its second sentence has none. The
    // block's group must not answer for a phrase that was never touched.
    const span = [...document.querySelectorAll<HTMLElement>('[data-block-id="ch09#b1"] [data-s]')][1] as HTMLElement;
    await tap(span);
    expect(rec()).not.toBeNull();
    expect(document.querySelector('.rec-notice')).toBeNull();
    await press('.rec-cta');
    expect(document.querySelector('form[data-form]')).not.toBeNull();
  });

  it('closes the form on Escape first and the block on the second Escape, keeping the draft', async () => {
    await mountChapter();
    await tap(sentences()[1] as HTMLElement);
    await press('.rec-cta');
    typeInto('textarea.seam-text', 'Черновик, который не должен пропасть.');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await frames();
    expect(rec()?.getAttribute('data-body')).toBe('list');
    expect(rec()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await frames(8);
    expect(rec()).toBeNull();
    // Reopening the sentence restores the draft the store kept.
    await tap(sentences()[1] as HTMLElement);
    await press('.rec-cta');
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe(
      'Черновик, который не должен пропасть.',
    );
  });

  it('a second tap on the sentence closes the block but never discards the draft', async () => {
    await mountChapter();
    const span = sentences()[1] as HTMLElement;
    await tap(span);
    await press('.rec-cta');
    typeInto('textarea.seam-text', 'Черновик под пальцем.');
    await tap(span);
    expect(rec()).toBeNull();
    await tap(span);
    await press('.rec-cta');
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe('Черновик под пальцем.');
  });
});

describe('the guard: every sentence of a chapter with a filing opens its record', () => {
  it('walks every sentence in every block, not one of them', async () => {
    await mountChapter();
    const all = sentences();
    expect(all.length).toBe(6);
    const quotes: string[] = [];
    for (const span of all) {
      await tap(span);
      const block = rec();
      expect(block, `no record for ${span.textContent ?? ''}`).not.toBeNull();
      expect(block?.getAttribute('data-acc')).toBe('open');
      // The quote is the tapped sentence, not a neighbour's.
      const quote = span.getAttribute('data-quote') ?? '';
      expect(document.querySelector('.rec-quote')?.textContent).toContain(quote);
      quotes.push(quote);
      await press('.rec-close');
      await frames(8);
      expect(rec()).toBeNull();
    }
    // Six sentences, six distinct quotes: the tap resolved each sentence on its own.
    expect(new Set(quotes).size).toBe(all.length);
  });
});
