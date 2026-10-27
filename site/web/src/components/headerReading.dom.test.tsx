// @vitest-environment jsdom
import { chapterStartPages, type CatalogEntry, type StateSnapshot } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Header } from './Header.tsx';

/**
 * BOOK-104 — the running head's chapter, the folio's page and the contents' page are one
 * model, and one line decides it: `--offset-top` plus 2 px, at the top of the reading area.
 *
 * jsdom has no layout, so every rect comes from a table: 67 slots laid end to end below the
 * cover and the contents. A browser lands an anchor at `top − offset-top` (`scroll-margin-top`)
 * — that is what `anchorTo` reproduces — so the head must name the anchored chapter at once
 * and the folio must print the number the contents prints for it.
 *
 * The head's word still comes from the slot (a premise's state word is not in the catalogue),
 * so the slots here carry the words a real page carries.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u'));
  return match?.[1] ?? '';
}

/** The body of `@media (<query>) { … }`, with nested braces balanced. */
function mediaBody(css: string, query: string): string {
  const start = css.search(new RegExp(`@media \\(${query}\\)\\s*\\{`, 'u'));
  if (start < 0) return '';
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  return '';
}

/** `--offset-top` in jsdom: the token cannot be read, so the hook keeps its 64 px fallback. */
const HEAD = 64;
/** The measured defect's slot: an empty chapter is a ~90 px row. */
const SLOT = 90;
/** ch01 starts below the cover, page 2 and the contents. */
const BASE = 700;

const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-27T12:00:00Z',
  engine: { status: 'unknown', heartbeatAt: null, laneId: null },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-27T10:00:00Z' },
  chapters: { total: 67, written: [1], empty: [2, 21, 67], count: 1, totalChars: 12_000, basis: [] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 67, cursor: 1, next: 2, status: 'idle', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: 67, to: 1, cursor: 67, next: 66, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 1, backwardFront: 67, gap: 0, converged: false, seam: 'not_reached' },
  cascade: null,
  queue: {
    depth: 0,
    byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 },
    head: null,
    processing: null,
    lastDecidedAt: null,
  },
  revising: [],
  current: null,
  unresolved: [],
  activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
  history: { live: false, readerChanges: 0, started: false },
};

type Box = { top: number; height: number };

/** ch01 and ch67 are the frozen basis slots: no premise row, so no state word either. */
function catalogOf(overrides: Partial<CatalogEntry>[] = []): CatalogEntry[] {
  const byNumber = new Map(overrides.map((entry) => [entry.n, entry]));
  return Array.from({ length: 67 }, (_, index) => {
    const n = index + 1;
    return {
      n,
      part: 1,
      title: null,
      rev: 1,
      chars: 0,
      blocks: 0,
      written: false,
      basis: n === 1 || n === 67,
      writtenAt: null,
      updatedAt: null,
      direction: 'forward',
      ...byNumber.get(n),
    } as CatalogEntry;
  });
}

/** A written chapter's own shape: how tall it is and how its prose is split into blocks. */
type Tall = { height: number; blocks: { id: string; chars: number }[] };

const rects = new Map<Element, Box>();
const articles = new Map<number, HTMLElement>();

function rectOf(entry: Box): DOMRect {
  const top = entry.top - window.scrollY;
  return {
    top,
    bottom: top + entry.height,
    height: entry.height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => entry,
  } as DOMRect;
}

function stubRects(): void {
  for (const [element, entry] of rects) element.getBoundingClientRect = () => rectOf(entry);
}

/** The book in the DOM: one article per catalogue slot, stacked, with the words it prints. */
function buildBook(catalog: readonly CatalogEntry[], tall = new Map<number, Tall>()): void {
  rects.clear();
  articles.clear();
  let top = BASE;
  for (const entry of catalog) {
    const extra = tall.get(entry.n);
    const height = extra?.height ?? SLOT;
    const article = document.createElement('article');
    article.className = entry.written ? 'ch' : 'ch ch-empty';
    article.id = `ch-${entry.n}`;
    article.dataset.n = String(entry.n);
    article.dataset.rev = String(entry.rev);
    if (entry.title !== null) {
      const title = document.createElement('h3');
      title.className = 'ch-title';
      title.textContent = entry.title;
      article.append(title);
    }
    if (!entry.written && !entry.basis) {
      const label = document.createElement('span');
      label.className = 'premise-label';
      label.textContent = 'замысел';
      article.append(label);
    }
    const blocks = extra?.blocks ?? [];
    // Prose is split evenly down the slot: a block's own share is all `charsInBlocks` needs.
    blocks.forEach((block, index) => {
      const paragraph = document.createElement('p');
      paragraph.dataset.blockId = block.id;
      paragraph.setAttribute('data-chars', String(block.chars));
      const blockTop = top + Math.round((height / blocks.length) * index);
      rects.set(paragraph, { top: blockTop, height: Math.round(height / blocks.length) });
      article.append(paragraph);
    });
    rects.set(article, { top, height });
    articles.set(entry.n, article);
    document.body.append(article);
    top += height;
  }
  stubRects();
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(catalog: readonly CatalogEntry[]): Promise<void> {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <Header state={STATE} ribbon={null} catalog={catalog} markers={[]} onOpenChange={() => undefined} live />,
    );
  });
}

function scrollTo(scroll: number): Promise<void> {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: scroll });
  return act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
}

/** What a browser does for `#ch-n`: `scroll-margin-top` lands the slot at `--offset-top`. */
function anchorTo(n: number): Promise<void> {
  const box = rects.get(articles.get(n) as Element);
  if (box === undefined) throw new Error(`no slot ${n}`);
  return scrollTo(box.top - HEAD);
}

function topOf(n: number): number {
  const box = rects.get(articles.get(n) as Element);
  if (box === undefined) throw new Error(`no slot ${n}`);
  return box.top;
}

function chip(): HTMLElement {
  const node = container.querySelector<HTMLElement>('.top-chapter');
  if (node === null) throw new Error('no .top-chapter');
  return node;
}

/** The folio's printed page, or null where the leaf renders nothing at all. */
function folio(): string | null {
  return container.querySelector<HTMLElement>('.folio')?.getAttribute('data-page') ?? null;
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  // The document's end is stubbed per test; zero is a page that cannot be scrolled to its end.
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 0 });
  rects.clear();
  articles.clear();
});

describe('the running head and the folio on one line', () => {
  it('names the anchored chapter and prints the contents page for it: 1, 21, 34, 50, 67', async () => {
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    const starts = chapterStartPages(catalog);
    for (const n of [1, 21, 34, 50, 67]) {
      await anchorTo(n);
      expect(chip().getAttribute('data-n')).toBe(String(n));
      expect(chip().querySelector('.top-chapter-n')?.textContent).toBe(String(n));
      expect(folio()).toBe(String(starts.get(n)));
    }
    // The empty slots also carry their own word; the frozen ones print the number alone.
    await anchorTo(21);
    expect(chip().querySelector('.top-chapter-w')?.textContent).toBe('замысел');
    await anchorTo(67);
    expect(chip().querySelector('.top-chapter-w')).toBeNull();
  });

  it('does not need the anchor’s whole 2 px: a fractional landing still names the target', async () => {
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    // Browsers round a smooth scroll: the slot can land 1.5 px above the line. The eps is
    // that rounding — without it the head would name ch20 at `#ch-21`.
    await scrollTo(topOf(21) - HEAD - 1.5);
    expect(chip().getAttribute('data-n')).toBe('21');
    // Past the eps, the previous chapter honestly owns the line: the boundary is measured.
    await scrollTo(topOf(21) - HEAD - 2.5);
    expect(chip().getAttribute('data-n')).toBe('20');
  });

  it('pages a written chapter from its own prose: start page, then one page further', async () => {
    const catalog = catalogOf([{ n: 20, written: true, chars: 3_600, blocks: 2, direction: 'forward' }]);
    buildBook(
      catalog,
      new Map([[20, { height: 600, blocks: [{ id: 'a', chars: 1_800 }, { id: 'b', chars: 1_800 }] }]]),
    );
    await mount(catalog);
    const start = chapterStartPages(catalog).get(20) ?? 0;

    await anchorTo(20);
    expect(chip().getAttribute('data-n')).toBe('20');
    expect(folio()).toBe(String(start));

    // 450 px in: 1800 characters of the first block plus 900 of the second, so the second page.
    await scrollTo(topOf(20) + 450 - 66);
    expect(chip().getAttribute('data-n')).toBe('20');
    expect(folio()).toBe(String(start + 1));

    // Off the chapter's last pixel the next slot owns the line, and its page is the next start.
    await scrollTo(topOf(20) + 600 - 66);
    expect(chip().getAttribute('data-n')).toBe('21');
    expect(folio()).toBe(String(start + 2));
  });

  it('keeps the frozen ch01 on page 1: one paragraph of 48 characters is no page at all', async () => {
    const catalog = catalogOf([{ n: 1, basis: true, chars: 48, blocks: 1 }]);
    buildBook(catalog, new Map([[1, { height: 90, blocks: [{ id: 'ch01#frame', chars: 48 }] }]]));
    await mount(catalog);

    await anchorTo(1);
    expect(chip().getAttribute('data-n')).toBe('1');
    expect(folio()).toBe('1');
    await scrollTo(topOf(1) + 80 - 66); // still inside the frame sentence
    expect(folio()).toBe('1');
  });

  it('names the last chapter at the document’s end, and the line’s own above it', async () => {
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    const starts = chapterStartPages(catalog);
    const last = rects.get(articles.get(67) as Element);
    if (last === undefined) throw new Error('no slot 67');
    const height = last.top + last.height; // nothing below it: the page ends with ch67
    const scrollHeight = () => height;
    // Scrolled to the end: the line is still inside ch58 (nothing can push ch67 up to it) —
    // the reported defect, reproduced: the head named the chapter the line was in.
    await scrollTo(height - 900);
    expect(chip().getAttribute('data-n')).toBe('58');
    // With the document's own end, the last chapter owns the reader and prints its last page —
    // for an empty slot that is the page the contents calls its own.
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, get: scrollHeight });
    await act(async () => {
      window.dispatchEvent(new Event('resize')); // re-measure at the same scroll
    });
    expect(chip().getAttribute('data-n')).toBe('67');
    expect(folio()).toBe(String(starts.get(67)));
    // One viewport above the end the ordinary rule holds: the line's chapter, not the last.
    await scrollTo(height - 900 - 900);
    expect(chip().getAttribute('data-n')).toBe('48');
    expect(folio()).toBe(String(starts.get(48)));
  });
});

describe('the head’s copy', () => {
  it('prints the chapter’s title in full, never an ellipsis', async () => {
    const catalog = catalogOf([
      { n: 30, written: true, chars: 600, blocks: 1, title: 'Комната на восьмом' },
    ]);
    buildBook(catalog, new Map([[30, { height: 90, blocks: [{ id: 't', chars: 600 }] }]]));
    await mount(catalog);
    await anchorTo(30);
    expect(chip().textContent).toContain('30');
    expect(chip().textContent).toContain('Комната на восьмом');
    expect(chip().textContent).not.toContain('…');
    // No clipping in the DOM contract either: the label span carries no truncation style.
    const css = sheets['../styles/running-head.css'] ?? '';
    expect(css).not.toMatch(/\.top-chapter-w\s*\{[^}]*(overflow|text-overflow)/u);
  });

  it('drops a title that does not fit the head for the state word, never clips it', async () => {
    const catalog = catalogOf([
      {
        n: 30,
        written: false,
        chars: 0,
        blocks: 0,
        title: 'Очень длинное название главы, которое не помещается',
      },
    ]);
    buildBook(catalog);
    await mount(catalog);
    // The head is measured as already overflowing, then the slot is opened.
    const head = container.querySelector<HTMLElement>('.top-in');
    Object.defineProperty(head, 'scrollWidth', { configurable: true, get: () => 900 });
    Object.defineProperty(head, 'clientWidth', { configurable: true, get: () => 300 });
    await anchorTo(30);
    await act(async () => {
      await Promise.resolve();
    });
    expect(chip().textContent).toContain('30');
    expect(chip().textContent).toContain('замысел');
    expect(chip().textContent).not.toContain('Очень длинное');
    expect(chip().textContent).not.toContain('…');
  });

  it('follows a word that changes under the named slot: a premise arriving renames it', async () => {
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    await anchorTo(21);
    expect(chip().querySelector('.top-chapter-w')?.textContent).toBe('замысел');
    const label = articles.get(21)?.querySelector('.premise-label');
    if (label === null || label === undefined) throw new Error('no premise row');
    await act(async () => {
      label.textContent = 'принято';
      await Promise.resolve();
    });
    expect(chip().querySelector('.top-chapter-w')?.textContent).toBe('принято');
  });

  it('keeps the number alone on the phone (the word is hidden by the sheet)', async () => {
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    await anchorTo(21);
    // The DOM keeps both; the 599 step hides the word, so the phone prints the number alone.
    expect(chip().querySelector('.top-chapter-n')?.textContent).toBe('21');
    expect(chip().querySelector('.top-chapter-w')?.textContent).toBe('замысел');
    const css = sheets['../styles/running-head.css'] ?? '';
    expect(css).toMatch(/@media \(max-width: 599px\)[\s\S]*\.top-chapter-w[\s\S]*display: none/u);
  });
});

describe('the head’s layout', () => {  it('keeps one reserved chip inside the existing first row — never a third row', async () => {
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    await anchorTo(1);
    expect(container.querySelectorAll('.top-row')).toHaveLength(2);
    const rows = container.querySelectorAll('.top-row');
    expect(rows[0]?.querySelector('.brand')).not.toBeNull();
    expect(rows[0]?.querySelector('.top-chapter')).toBe(chip());
    expect(rows[1]?.querySelector('.live')).not.toBeNull();
    // The folio is the first row's last item: the head and the number are one line.
    expect(rows[0]?.querySelector('.folio')).not.toBeNull();
    // The old `display: contents` is what spread four items across the line; it is gone, and the
    // left cluster keeps one 24 px gap between the brand and the chip.
    const chrome = sheets['../styles/chrome.css'] ?? '';
    expect(chrome).not.toContain('display: contents');
    expect(chrome).toMatch(/\.top-in \.top-row:first-child \{[^}]*gap: 24px/u);
    const css = sheets['../styles/running-head.css'] ?? '';
    expect(css).toContain('font-family: var(--label)');
    expect(css).toContain('font-size: var(--fs-micro)');
    expect(css).toContain('font-variant-numeric: tabular-nums');
    // BOOK-90: the chip is never clipped and has no fixed measure; only the number reserves
    // two tabular digits, so 9 → 10 cannot shift the word after it.
    expect(css).not.toMatch(/text-overflow:\s*ellipsis/u);
    expect(css).not.toMatch(/\.top-chapter\s*\{[^}]*width:/u);
    expect(css).toMatch(/\.top-chapter-n\s*\{[^}]*min-width: 2ch/u);
    // No new rung: the chip is the floor, not a smaller size.
    expect(css).not.toMatch(/font-size:\s*(1[01](\.\d+)?px|0\.\d+rem)/u);
  });
});

describe('one number in the phone head', () => {
  it('hides the chapter chip below 768 and keeps the folio in the row', () => {
    const live = sheets['../styles/live.css'] ?? '';
    const phone = mediaBody(live, 'max-width: 767px');
    // BOOK-104: two bare numerals — chapter 61 beside page 64, «1 | 1» at the first chapter —
    // read as a duplicate, so the phone head prints the page alone.
    expect(declarations(phone, '.top-chapter')).toContain('display: none');
    // The folio is that one number: it stays the row's last item, and nothing under 768 hides it.
    expect(declarations(phone, '.folio')).toContain('position: static');
    for (const css of Object.values(sheets)) {
      expect(css).not.toMatch(/\.folio\s*\{[^}]*display:\s*none/u);
    }
    // Above 768 nothing changes: the chip is still a chip, the folio still in the margin.
    expect(sheets['../styles/running-head.css']).toMatch(/\.top-chapter \{[^}]*display: inline-flex/u);
    expect(declarations(live, '.folio')).toContain('position: fixed');
  });

  it('keeps the chip in the markup and reads as the brand and the page alone', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const catalog = catalogOf();
    buildBook(catalog);
    await mount(catalog);
    await anchorTo(21);
    const row = container.querySelector('.top-row');
    if (row === null) throw new Error('no first row');
    // Exactly one folio numeral in the row, and it is the page the contents prints.
    expect(row.querySelectorAll('.folio')).toHaveLength(1);
    expect(row.querySelector('.folio')?.textContent).toBe(String(chapterStartPages(catalog).get(21)));
    // The chip is still rendered — its hiding is the sheet's, not the markup's.
    expect(row.querySelector('.top-chapter')?.getAttribute('data-n')).toBe('21');
    // With the chip hidden, the phone row says the brand and the page, nothing else.
    const phone = row.cloneNode(true) as HTMLElement;
    phone.querySelector('.top-chapter')?.remove();
    expect(phone.textContent).toBe(`Книга · 67 глав${chapterStartPages(catalog).get(21)}`);
  });
});
