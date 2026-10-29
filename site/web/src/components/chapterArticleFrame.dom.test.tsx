// @vitest-environment jsdom
import { FRAME_FIRST_SENTENCE, FRAME_WARNING, type CatalogEntry, type ChapterDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-137 — the freeze is the canon **sentence**, not the chapter, proved on the page.
 *
 * Split from `chapterArticle.dom.test.tsx` (the file's 500-line budget): the strip's tap target
 * needs a caret stub, and the rest of that file is about the skeleton's height and the wait.
 * These mount a real written ch01 and ch65: a sentence span opens the strip on the word that was
 * tapped, «вмешаться» is there, and only the sentence answers «рамка книги · не меняется».
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
  chars: 22_628,
  blocks: 180,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  // The caret is stubbed on the document itself (jsdom has no hit-testing), not on a global.
  delete (document as Partial<Document>).caretPositionFromPoint;
  delete (document as Partial<Document>).caretRangeFromPoint;
  vi.unstubAllGlobals();
});

/** The stubbed `prefers-reduced-motion` answer: the text lands set, not typing. */
function stillMotion(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * BOOK-137 — the freeze is the canon **sentence**, not the chapter. The owner, on chapter 1
 * (written, 24 434 characters): «в первой главе я не могу вмешаться, а должен». These mount a
 * real written ch01 and ch65 and prove the tap target: a sentence span opens the strip on that
 * word, «вмешаться» is there, and only the sentence answers «рамка книги · не меняется».
 */

/** `Я вошёл в пустую комнату. Её освещал яркий свет.` then the author's own prose. */
const CH01_BLOCKS = [
  FRAME_FIRST_SENTENCE,
  'Свет был включён до меня, и это было странно.',
  'Часы на стене шли.',
  'Записку оставили на столе.',
];

function writtenChapter(n: number, texts: readonly string[]): ChapterDto {
  const tag = String(n).padStart(2, '0');
  return {
    n,
    title: null,
    rev: 1,
    chars: texts.join(' ').length,
    basis: false,
    blocks: texts.map((text, i) => ({ id: `ch${tag}#b${i}`, i, text, hash: `h${i}` })),
    writtenAt: '2026-10-25T09:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
  };
}

/** A controlled textarea needs the native setter, or React never sees the change. */
function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mountWritten(entry: CatalogEntry, body: ChapterDto): Promise<HTMLDivElement> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response),
  );
  stillMotion();
  vi.stubGlobal('IntersectionObserver', EagerObserver);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ChapterArticle
        entry={entry}
        revision={null}
        revising={null}
        caret={null}
        fresh={false}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        history
      />,
    );
  });
  await flush();
  return container;
}

/**
 * One tap, as the browser sends it: `pointerdown` → `pointerup` → `click` (`detail: 1`). The
 * click belongs to the same gesture and must not replay the opening (the owner's phone defect).
 */
function gesture(span: HTMLElement): void {
  span.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 4, clientY: 4, pointerId: 1, isPrimary: true }));
  span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 4, clientY: 4, pointerId: 1, isPrimary: true }));
  span.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 4, clientY: 4, detail: 1 }));
}

/** A tap on the first sentence of one block — the pointer the strip is meant to answer. */
async function tapBlock(container: HTMLElement, blockId: string): Promise<void> {
  const span = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"] [data-s]`);
  if (span === null) throw new Error(`no sentence span in ${blockId}`);
  await act(async () => {
    gesture(span);
  });
}

/**
 * A tap **inside a word**, which jsdom has no hit-testing for: `wordOffsetIn` reads the caret
 * the browser would have placed, so the caret is stubbed the way it reads it — a point in the
 * sentence's own text node. Without this the tap always resolved to the sentence's first word,
 * and a strip that ignored the pointer would still have looked right. `fallback` stubs only
 * `caretRangeFromPoint`, the second API the component reads, so both paths are proved.
 */
function stubCaret(span: HTMLElement, offset: number, fallback = false): void {
  // The sentence's text lives in its own door span (the numerals are siblings).
  const node = span.querySelector('.sentence-door')?.firstChild ?? span.firstChild;
  if (node === null) throw new Error('the sentence span has no text node');
  // jsdom's own `Document` type carries neither API, and the browser's `CaretPosition` carries
  // more than the component reads — the stub supplies exactly the two fields it uses.
  const doc = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const range = (): Range => {
    const made = document.createRange();
    made.setStart(node, offset);
    made.collapse(true);
    return made;
  };
  if (!fallback) doc.caretPositionFromPoint = () => ({ offsetNode: node, offset });
  doc.caretRangeFromPoint = range;
}

/** A tap that lands on `word` inside a block's sentence, at that word's own char offset. */
async function tapWord(container: HTMLElement, blockId: string, word: string, fallback = false): Promise<void> {
  const span = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"] [data-s]`);
  if (span === null) throw new Error(`no sentence span in ${blockId}`);
  const at = (span.textContent ?? '').indexOf(word);
  if (at < 0) throw new Error(`«${word}» is not in the tapped sentence`);
  stubCaret(span, at + 1, fallback);
  await act(async () => {
    gesture(span);
  });
}

describe('the canon sentence is frozen, chapter 1 is not (BOOK-137)', () => {
  it('opens the strip on a mid-chapter prose block, with «вмешаться» and a live form', async () => {
    const container = await mountWritten(ENTRY, writtenChapter(1, CH01_BLOCKS));
    // The rail (§4) is on the prose of a written ch01 — the owner's own «вмешаться».
    expect(container.querySelector('[data-block-id="ch01#b3"] .seam-rail')).not.toBeNull();

    // The pointer lands **inside** «столе», the sentence's last word: the strip must name the
    // word that was tapped, not the sentence's first one.
    await tapWord(container, 'ch01#b3', 'столе');
    // BOOK-128 #3852 — the block names the very word the tap landed in, in the prose and in
    // its own accessible name, and it is an ordinary (unfrozen) record.
    const block = container.querySelector('.rec');
    expect(block).not.toBeNull();
    // ADR-044 — the mark is the sentence; the word under the tap is underlined in the quote.
    expect(container.querySelector('[data-touch]')?.textContent).toBe('Записку оставили на столе.');
    expect(container.querySelector('.rec-word')?.textContent).toBe('столе');
    expect(block?.getAttribute('aria-label')).toContain('столе');
    expect(block?.textContent).toContain('вмешаться');
    expect(block?.textContent).not.toContain('закреплено');
    expect(block?.textContent).not.toContain('рамка книги');
    expect(block?.querySelector('.rec-frame-note')).toBeNull();

    // The form is a state of the same block, and only the draft decides whether it can be sent.
    await act(async () => {
      (container.querySelector('.rec-cta') as HTMLElement).click();
    });
    const submit = (): HTMLButtonElement | null => container.querySelector<HTMLButtonElement>('.seam-submit');
    expect(submit()).not.toBeNull();
    expect(submit()?.disabled).toBe(true);
    await act(async () => {
      typeInto('.seam-text', 'Записку оставили не ему.');
    });
    expect(submit()?.disabled).toBe(false);
  });

  it('says the frame does not change on the sentence’s own block, and still takes the filing', async () => {
    const container = await mountWritten(ENTRY, writtenChapter(1, CH01_BLOCKS));
    // The frame paragraph is the one paragraph with no rail of its own; a tap still works.
    expect(container.querySelector('[data-block-id="ch01#b0"] .seam-rail')).toBeNull();

    await tapBlock(container, 'ch01#b0');
    const block = container.querySelector('.rec');
    expect(block).not.toBeNull();
    // The frame's line and link are the record's, printed before the reader types.
    expect(block?.querySelector('.rec-frame-note')?.textContent).toContain('рамка книги →');
    expect(block?.querySelector('.rec-frozen')?.getAttribute('href')).toBe('/rules#рамка');
    expect(block?.querySelector('.rec-frame-note')?.textContent).toContain(FRAME_WARNING);
    expect(block?.querySelector('.seam-form')).toBeNull();
    // «вмешаться» is offered here too: the filing is taken and filed as paperwork.
    expect(block?.querySelector('.rec-cta')?.textContent).toBe('вмешаться');
    await act(async () => {
      (container.querySelector('.rec-cta') as HTMLElement).click();
    });
    expect(container.querySelector('.seam-form')).not.toBeNull();
  });

  it('treats a written ch65 as ordinary prose: no frame, no frozen strip', async () => {
    // Prod's own API: ch65 is `basis: false, written: true`. Nothing may close it.
    const container = await mountWritten(
      { ...ENTRY, n: 65, title: null, basis: false, written: true },
      writtenChapter(65, ['Свет был включён до меня.', 'Часы на стене шли.', 'Записку оставили на столе.']),
    );
    // The second caret API (`caretRangeFromPoint`) is the one this browser has: same word.
    await tapWord(container, 'ch65#b1', 'стене', true);
    const block = container.querySelector('.rec');
    expect(container.querySelector('[data-touch]')?.textContent).toBe('Часы на стене шли.');
    expect(container.querySelector('.rec-word')?.textContent).toBe('стене');
    expect(block?.getAttribute('aria-label')).toContain('стене');
    expect(block?.textContent).toContain('вмешаться');
    expect(block?.querySelector('.rec-frame-note')).toBeNull();
    expect(block?.querySelector('.rec-frozen')).toBeNull();
  });
});
