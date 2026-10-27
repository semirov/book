// @vitest-environment jsdom
import { FRAME_FIRST_SENTENCE, FRAME_WARNING, type CatalogEntry, type ChapterDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { estimateChapterHeight } from '../lib/layout.ts';
import { CHAPTER_BOX_PX } from '../lib/skeleton.ts';
import { ChapterArticle } from './ChapterArticle.tsx';

/**
 * BOOK-30 — the skeleton's height is a real CSSOM write.
 *
 * The server-render tests can only prove the markup has no style attribute; they would stay
 * green if the ref were dropped and the slot collapsed. This mounts the component in jsdom
 * and reads the inline style the browser actually gets.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** The chapter never comes into view: the slot must reserve its height before any fetch. */
class IdleObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

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
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

let root: Root | null = null;

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/**
 * BOOK-DOC-43 §4, §6, §7 — the chapter's wait (BOOK-66).
 *
 * The fetch stays pending until the test resolves it: the threshold is only provable while
 * nothing has landed. Two observers answer `isIntersecting: true`, because `load()` starts on
 * approach and a slot that never comes into view never waits. Reduced motion is stubbed on
 * purpose — the prose then arrives at once, so the commit that removes the placeholder is the
 * only thing under test (no printing loop, no rAF churn).
 */

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

class ApproachingObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

type Pending = { promise: Promise<Response>; resolve: (body: unknown) => void; reject: (error: Error) => void };

/** A request the test answers by hand: a deferred `fetch` keeps the wait open on purpose. */
function pendingFetch(): Pending {
  let settle: (body: unknown) => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const promise = new Promise<Response>((resolve, reject) => {
    settle = (body) => resolve({ ok: true, status: 200, statusText: 'OK', json: async () => body } as unknown as Response);
    fail = (error) => reject(error);
  });
  return { promise, resolve: settle, reject: fail };
}

function chapter(n: number): ChapterDto {
  return {
    n,
    title: null,
    rev: 1,
    chars: 24,
    basis: false,
    blocks: [{ id: `ch${n}#1`, i: 0, text: 'Первая фраза главы.', hash: 'h1' }],
    writtenAt: '2026-10-25T09:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the chapter wait under a browser', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stillMotion();
    vi.stubGlobal('IntersectionObserver', ApproachingObserver);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing for 149 ms, then the form with one sentence, then the text', async () => {
    const wait = pendingFetch();
    const fetchMock = vi.fn(() => wait.promise);
    vi.stubGlobal('fetch', fetchMock);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, n: 7 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nothing has waited long enough yet, and a request hangs while we count.
    expect(container.querySelector('.skel')).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(149);
    });
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    const skel = container.querySelector('.skel');
    expect(skel).not.toBeNull();
    expect(skel?.getAttribute('data-lines')).toBe('8');
    expect(container.querySelectorAll('.skel-line')).toHaveLength(8);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('читаем главу 07');
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe('true');

    // At 2 000 ms the same slot replaces the form's company with one plain sentence.
    await act(async () => {
      vi.advanceTimersByTime(1_851);
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'глава идёт дольше обычного · текст появится здесь же',
    );
    expect(container.querySelectorAll('.skel')).toHaveLength(1);

    // The text lands: the form goes in the same commit, with no fade out and no stale stage.
    await act(async () => {
      wait.resolve(chapter(7));
    });
    await flush();
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('article')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('drops the form the moment the fetch fails, and leaves the sentence and the retry', async () => {
    const wait = pendingFetch();
    vi.stubGlobal('fetch', vi.fn(() => wait.promise));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, n: 7 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    await act(async () => {
      vi.advanceTimersByTime(150);
    });
    expect(container.querySelector('.skel')).not.toBeNull();

    await act(async () => {
      wait.reject(new Error('offline'));
    });
    await flush();

    // A failure is not a longer wait: the error copy replaces the placeholder immediately.
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('.ch-placeholder')).toBeNull();
    expect(container.querySelector('.ch-fail')?.textContent).toContain('глава не загрузилась');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('article')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('keeps a basis slot silent: its frame is complete before the request', async () => {
    const wait = pendingFetch();
    vi.stubGlobal('fetch', vi.fn(() => wait.promise));
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, n: 67, written: false, basis: true, chars: 0, blocks: 1 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });

    // The frozen frame is already the final text: a wait for its ids claims nothing.
    expect(container.querySelector('.skel')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('article')?.hasAttribute('aria-busy')).toBe(false);
    await act(async () => {
      wait.resolve(chapter(67));
    });
    await flush();
  });
});

describe('the chapter skeleton under a browser', () => {
  it('writes the reserved height onto the placeholder through CSSOM', async () => {
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={ENTRY} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });

    const placeholder = container.querySelector<HTMLElement>('.ch-placeholder');
    expect(placeholder).not.toBeNull();
    const expected = estimateChapterHeight(ENTRY.chars, window.innerWidth || 390);
    expect(expected).toBeGreaterThan(1_000);
    expect(placeholder?.style.minHeight).toBe(`${expected}px`);
  });

  it('floors a short written chapter’s box at the form’s height, so the text cannot move the page', async () => {
    // §3 as corrected: `max(estimate, 279)`. A 49-char chapter estimates 120 px, and the form
    // (8 × 1.68em + 2 × 1.02em of the prose size) is taller than that — it would overrun the
    // box and the arriving text would move everything below it. jsdom has no layout, so the
    // form's height is read from the same geometry `skeleton.css` sets.
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    const viewport = window.innerWidth || 390;
    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, chars: 49 }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });

    const prose = viewport < 600 ? 17 : viewport < 1024 ? 17.5 : 18;
    const form = 8 * 1.68 * prose + 2 * 1.02 * prose;
    expect(estimateChapterHeight(49, viewport)).toBe(120);
    expect(CHAPTER_BOX_PX).toBe(279);
    expect(form).toBeLessThanOrEqual(CHAPTER_BOX_PX);
    const placeholder = container.querySelector<HTMLElement>('.ch-placeholder');
    expect(placeholder?.style.minHeight).toBe(`${CHAPTER_BOX_PX}px`);
  });

  it('prints «печатается» as a separate chip while the text arrives, and never «не написана»', async () => {
    // BOOK-70: the header's state chip is its own span, apart from the data line. The reveal
    // starts only in a browser, so this is where the printing state can be observed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          n: 1,
          title: 'Тестовая глава',
          rev: 1,
          chars: 40,
          basis: false,
          blocks: [
            { id: 'ch01#aaaa1111', i: 0, text: 'Первое предложение главы, которое печатается.', hash: 'a' },
            { id: 'ch01#bbbb2222', i: 1, text: 'Второе предложение главы.', hash: 'b' },
          ],
          writtenAt: '2026-10-25T09:20:00Z',
          updatedAt: '2026-10-25T09:20:00Z',
        }),
      })),
    );
    vi.stubGlobal('IntersectionObserver', EagerObserver);
    // The reveal asks the media query; jsdom does not implement it, and a throw there would
    // land in the load's `catch` and read as a failed chapter.
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, chars: 40 }} revision={null} revising={null} caret={null} fresh composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });
    // The load is a promise: let it settle, then read the header.
    await flush();

    const print = container.querySelector('.ch-print');
    expect(print?.textContent).toBe('■ печатается');
    expect(print?.closest('.ch-data')).toBeNull();
    expect(container.querySelector('.ch-data')?.textContent).toContain('12:20');
    expect(container.textContent).not.toContain('не написана');
  });

  it('renders an empty slot with no placeholder at all', async () => {
    vi.stubGlobal('IntersectionObserver', IdleObserver);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<ChapterArticle entry={{ ...ENTRY, written: false }} revision={null} revising={null} caret={null} fresh={false} composer={EMPTY_COMPOSER} viewer={{ signedIn: false, displayName: null }} history />);
    });

    expect(container.querySelector('.ch-placeholder')).toBeNull();
  });
});

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

/** A tap on the first sentence of one block — the pointer the strip is meant to answer. */
async function tapBlock(container: HTMLElement, blockId: string): Promise<void> {
  const span = container.querySelector<HTMLElement>(`[data-block-id="${blockId}"] [data-s]`);
  if (span === null) throw new Error(`no sentence span in ${blockId}`);
  await act(async () => {
    span.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 4, clientY: 4 }));
  });
}

describe('the canon sentence is frozen, chapter 1 is not (BOOK-137)', () => {
  it('opens the strip on a mid-chapter prose block, with «вмешаться» and a live form', async () => {
    const container = await mountWritten(ENTRY, writtenChapter(1, CH01_BLOCKS));
    // The rail (§4) is on the prose of a written ch01 — the owner's own «вмешаться».
    expect(container.querySelector('[data-block-id="ch01#b3"] .seam-rail')).not.toBeNull();

    await tapBlock(container, 'ch01#b3');
    const seam = container.querySelector('.seam');
    expect(seam).not.toBeNull();
    // The word is the tapped sentence's first word, not the paragraph.
    expect(seam?.querySelector('.seam-word')?.textContent).toBe('«Записку»');
    expect(seam?.textContent).toContain('вмешаться');
    expect(seam?.textContent).not.toContain('закреплено');
    expect(seam?.textContent).not.toContain('рамка книги');
    expect(seam?.getAttribute('data-frozen')).toBeNull();
    expect(seam?.querySelector('.seam-frame')).toBeNull();

    // The form grows in the strip, and only the draft decides whether it can be sent.
    await act(async () => {
      (container.querySelector('.seam-cta') as HTMLElement).click();
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
    const seam = container.querySelector('.seam');
    expect(seam?.querySelector('.seam-prov')?.textContent).toBe('рамка книги · не меняется');
    expect(seam?.querySelector('.seam-frozen')?.getAttribute('href')).toBe('/rules#рамка');
    expect(seam?.getAttribute('data-frozen')).toBe('true');
    // The warning line is in the strip before the reader types, and the form is not open yet.
    expect(seam?.getAttribute('data-state')).toBe('strip');
    expect(seam?.querySelector('.seam-note.seam-frame')?.textContent).toBe(FRAME_WARNING);
    expect(seam?.querySelector('.seam-form')).toBeNull();
    // «вмешаться» is offered here too: the filing is taken and filed as paperwork.
    expect(seam?.querySelector('.seam-cta')?.textContent).toBe('вмешаться');
    await act(async () => {
      (container.querySelector('.seam-cta') as HTMLElement).click();
    });
    expect(container.querySelector('.seam-form')).not.toBeNull();
  });

  it('treats a written ch65 as ordinary prose: no frame, no frozen strip', async () => {
    // Prod's own API: ch65 is `basis: false, written: true`. Nothing may close it.
    const container = await mountWritten(
      { ...ENTRY, n: 65, title: null, basis: false, written: true },
      writtenChapter(65, ['Свет был включён до меня.', 'Часы на стене шли.', 'Записку оставили на столе.']),
    );
    await tapBlock(container, 'ch65#b1');
    const seam = container.querySelector('.seam');
    expect(seam?.querySelector('.seam-word')?.textContent).toBe('«Часы»');
    expect(seam?.textContent).toContain('вмешаться');
    expect(seam?.getAttribute('data-frozen')).toBeNull();
    expect(seam?.querySelector('.seam-frame')).toBeNull();
    expect(seam?.querySelector('.seam-frozen')).toBeNull();
    expect(seam?.querySelector('.seam-prov')?.textContent).toBe('откуда это слово');
  });
});
