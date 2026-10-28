// @vitest-environment jsdom
import { partOf, TOTAL_CHAPTERS, type CatalogEntry, type ChangeDto, type StateSnapshot } from '@book/shared';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BREATHING_PX,
  OFFSET_BOTTOM_PROPERTY,
  OFFSET_TOP_PROPERTY,
  applyStickyOffsets,
  gripHeight,
  headerHeight,
  offsetOf,
  offsetTopOfPage,
  useStickyOffsets,
} from '../lib/headerOffset.ts';
import { ChangeCard } from './ChangeCard.tsx';
import { firstDeclarations, unionDeclarations } from './cssRules.ts';
import { TableOfContents } from './TableOfContents.tsx';

/**
 * The anchor contract (owner, 2026-10-28): **one measured source of truth** for where a jump
 * lands. jsdom has no layout, so every box below is stubbed deterministically — a head of a
 * known height, chapters at known document offsets — and the code's own arithmetic is applied
 * to those stubs (the scroll it asks for becomes `window.scrollY`, and every rect is a function
 * of that scroll).
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });

const HEADER_PX = 56;
/** `--offset-top` as the page gets it: the measured head plus the site's breathing space. */
const OFFSET_TOP = offsetOf(HEADER_PX);
const GRIP_PX = 44;
/** An open change card over the bottom edge: a band of a known height. */
const CARD_PX = 320;

/** A chapter's document top: far enough apart that landing one chapter off is visible. */
function chapterTop(n: number): number {
  return n * 1000;
}

function slot(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: partOf(n),
    title: null,
    rev: 0,
    chars: 0,
    blocks: 0,
    written: false,
    basis: false,
    opening: null,
    writtenAt: null,
    updatedAt: null,
    direction: n <= 21 ? 'forward' : 'backward',
    ...overrides,
  };
}

/** Two written chapters (one titled, one not) and 40 empty slots — the frames included. */
const CATALOG: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  if (n === 2) return slot(n, { title: 'Ночная смена', rev: 1, written: true, chars: 2000, blocks: 1 });
  if (n === 3) return slot(n, { written: true, rev: 1, chars: 2000, blocks: 1, opening: 'Свет был не для меня.…' });
  if (n === 1 || n === TOTAL_CHAPTERS) return slot(n, { basis: true, blocks: 1 });
  return slot(n);
});

const STATE = { chapters: { total: TOTAL_CHAPTERS }, front: { title: 'Бланк' } } as unknown as StateSnapshot;

/** The change card's own facts: nothing here is what the bottom-offset contract reads. */
function cardChange(): ChangeDto {
  return {
    id: 'chg_1',
    seq: 3,
    kind: 'accepted_comment',
    interventionKind: null,
    chapter: 2,
    intent: 'убрать второе упоминание абзаца',
    premise: false,
    premiseLanded: false,
    source: { commentId: 'cmt_1', author: 'Аня' },
    base: { rev: 1 },
    scopeHint: 'phrase',
    status: 'done',
    outcome: 'applied',
    reason: null,
    position: null,
    relevance: null,
    cascade: null,
    modes: [],
    steps: [],
    appliedRevs: [],
    cost: null,
    scienceCheck: null,
    history: null,
    enqueuedAt: '2026-10-27T09:00:00Z',
    startedAt: null,
    decidedAt: '2026-10-27T09:10:00Z',
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let scrollY = 0;
const scrollTo = vi.fn((options: ScrollToOptions) => {
  scrollY = Number(options.top ?? 0);
});

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** The head: a stubbed sticky row of a known height. */
function mountHeader(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'top';
  header.getBoundingClientRect = () => rect(0, HEADER_PX);
  document.body.append(header);
  return header;
}

/**
 * One chapter section whose border box begins at its heading — the CSS contract `.ch` keeps
 * (`margin-top`, never `padding-top`), so the heading's top *is* the section's top. A written
 * chapter also carries the title line below it, exactly as `ChapterArticle` renders both.
 */
function mountChapter(n: number): { section: HTMLElement; heading: HTMLElement } {
  const article = document.createElement('article');
  article.id = `ch-${n}`;
  const entry = CATALOG[n - 1];
  const heading = document.createElement(entry?.written === true ? 'header' : 'p');
  heading.className = entry?.written === true ? 'ch-h' : entry?.basis === true ? 'ch-frame' : 'premise-row';
  heading.textContent = entry?.written === true ? '' : 'Пусто';
  article.append(heading);
  if (entry?.written === true) {
    const title = document.createElement('h3');
    title.className = 'ch-title';
    title.textContent = entry.title ?? entry.opening ?? '';
    // The title line sits 34 px below the head of the section (its own margin in the sheet).
    title.getBoundingClientRect = () => rect(chapterTop(n) + 34 - scrollY, 40);
    article.append(title);
  }
  article.getBoundingClientRect = () => rect(chapterTop(n) - scrollY, 400);
  heading.getBoundingClientRect = () => rect(chapterTop(n) - scrollY, 40);
  document.body.append(article);
  return { section: article, heading };
}

function rowOf(n: number): HTMLAnchorElement {
  const row = [...container.querySelectorAll<HTMLElement>('#toc .toc-row')].find(
    (element) => element.querySelector('.toc-num')?.textContent === String(n).padStart(2, '0'),
  );
  if (row === null || row === undefined) throw new Error(`no contents row for chapter ${n}`);
  const link = row.querySelector('a.toc-link');
  if (link === null) throw new Error(`row ${n} is not a link`);
  return link as HTMLAnchorElement;
}

beforeEach(async () => {
  scrollY = 0;
  scrollTo.mockClear();
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
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(window, 'scrollTo', { configurable: true, value: scrollTo });
  mountHeader();
  // The flow holds all 42 slots, empty ones included: that is what makes every row an anchor.
  for (let n = 1; n <= TOTAL_CHAPTERS; n += 1) mountChapter(n);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root?.render(<TableOfContents catalog={CATALOG} state={STATE} currentChapter={null} />));
  applyStickyOffsets(document);
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a tap on a contents row lands the chapter at the head’s lower edge', () => {
  /**
   * The owner's words: «a tap on row N leaves the chapter's heading inside the viewport with
   * its top at the header's lower edge ±2 px». The breathing space is part of the offset, so
   * the assertion is against **header bottom + breathing space**, within 2 px — not against
   * the head's own edge.
   */
  it('lands row 2’s heading at header bottom + breathing space, within 2 px', async () => {
    const heading = document.querySelector<HTMLElement>('#ch-2 .ch-h');
    expect(heading).not.toBeNull();
    await act(async () => rowOf(2).click());

    expect(scrollTo).toHaveBeenCalledTimes(1);
    const headerBottom = document.querySelector<HTMLElement>('.top')!.getBoundingClientRect().bottom;
    const landing = heading!.getBoundingClientRect().top;
    expect(Math.abs(landing - (headerBottom + BREATHING_PX))).toBeLessThanOrEqual(2);
    // The arithmetic came from the measurement, not from a literal.
    expect(OFFSET_TOP).toBe(HEADER_PX + BREATHING_PX);
    expect(scrollY).toBe(chapterTop(2) - OFFSET_TOP);
  });

  it('opens an empty chapter at its own place, not at the written chapter above it', async () => {
    // ch03 is written, ch04 is empty: the row must land ch04's own section by id.
    const section = document.getElementById('ch-4');
    expect(section).not.toBeNull();
    await act(async () => rowOf(4).click());

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]?.[0]).toMatchObject({
      top: chapterTop(4) - (HEADER_PX + BREATHING_PX),
      // The fixture asks for reduced motion: an instant landing, never an animation.
      behavior: 'auto',
    });
    expect(scrollY).toBe(chapterTop(4) - (HEADER_PX + BREATHING_PX));
    expect(Math.abs(section!.getBoundingClientRect().top - (HEADER_PX + BREATHING_PX))).toBeLessThanOrEqual(2);
  });

  it('never swallows a click without a target: the browser’s own #ch-N jump stays', async () => {
    // A partial render (or a book whose flow is still mounting): the row must not call
    // `preventDefault` on a jump it cannot make.
    document.getElementById('ch-5')?.remove();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      rowOf(5).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps the last row reachable: the finale’s own anchor exists and is a link', async () => {
    const finale = document.getElementById(`ch-${TOTAL_CHAPTERS}`);
    expect(finale).not.toBeNull();
    await act(async () => rowOf(TOTAL_CHAPTERS).click());
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollY).toBe(chapterTop(TOTAL_CHAPTERS) - (HEADER_PX + BREATHING_PX));
  });
});

describe('the footer’s bottom contract', () => {
  /** The second required test: `scroll-margin-bottom` comes from the measured grip, not a literal. */
  it('derives scroll-margin-bottom from the measured grip height', () => {
    // A band over the viewport's bottom edge (the capacity plate) of a known height.
    const grip = document.createElement('aside');
    grip.className = 'capacity-plate';
    grip.getBoundingClientRect = () => rect(0, GRIP_PX);
    document.body.append(grip);

    const { bottom } = applyStickyOffsets(document);
    expect(bottom).toBe(GRIP_PX + BREATHING_PX);
    expect(document.documentElement.style.getPropertyValue(OFFSET_BOTTOM_PROPERTY)).toBe(`${GRIP_PX + BREATHING_PX}px`);
    expect(gripHeight(document)).toBe(GRIP_PX);

    // The sheet reads that property and states no number of its own.
    const colophon = unionDeclarations(sheets['../styles/book.css'] ?? '', '.colophon');
    expect(colophon).toContain('scroll-margin-bottom: var(--offset-bottom)');
    expect(colophon).not.toMatch(/scroll-margin-bottom:\s*\d/u);
    const tail = firstDeclarations(sheets['../styles/marginalia.css'] ?? '', '.margin-tail');
    expect(tail).toContain('min-height: var(--offset-bottom)');

    // Without the band the property goes away and the sheet's fallback stands: an absent
    // measurement is not a smaller truth.
    grip.remove();
    applyStickyOffsets(document);
    expect(document.documentElement.style.getPropertyValue(OFFSET_BOTTOM_PROPERTY)).toBe('');
  });

  it('measures the head, writes --offset-top, and reads the same number back', () => {
    expect(headerHeight(document)).toBe(HEADER_PX);
    expect(document.documentElement.style.getPropertyValue(OFFSET_TOP_PROPERTY)).toBe(`${OFFSET_TOP}px`);
    expect(offsetTopOfPage(document)).toBe(OFFSET_TOP);
  });
});

describe('a band that closes without a resize gives the bottom edge back', () => {
  /**
   * The owner's rule for `--offset-bottom`: it is written on plate mount, on head resize and on
   * window resize. A change card and the provenance chain are bands of the same kind, so a card
   * that **closes** (a `×`, a chapter tap, another card) must re-measure too — otherwise the
   * footer keeps reserving room for a box that is gone until the next resize.
   */
  it('measures the change card when it opens and re-measures when it closes', async () => {
    // jsdom has no layout: the card reports the height a browser would give it.
    const native = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      return this.classList.contains('change-card') ? rect(0, CARD_PX) : native.call(this);
    };
    const host = document.body.appendChild(document.createElement('div'));
    const card = createRoot(host);
    try {
      await act(async () => card.render(<ChangeCard change={cardChange()} onClose={() => undefined} />));
      expect(document.querySelector('.change-card')).not.toBeNull();
      expect(document.documentElement.style.getPropertyValue(OFFSET_BOTTOM_PROPERTY)).toBe(
        `${CARD_PX + BREATHING_PX}px`,
      );

      // Closed, and no resize happened: the offset shrinks back on its own.
      await act(async () => card.unmount());
      expect(document.documentElement.style.getPropertyValue(OFFSET_BOTTOM_PROPERTY)).toBe('');
    } finally {
      Element.prototype.getBoundingClientRect = native;
      host.remove();
    }
  });
});

describe('nothing hardcodes the head’s height', () => {
  it('writes the measured head plus breathing space at every head height', () => {
    for (const height of [56, 59.1, 76.6, 72, 80]) {
      const header = document.querySelector<HTMLElement>('.top')!;
      header.getBoundingClientRect = () => rect(0, height);
      const { top } = applyStickyOffsets(document);
      expect(top).toBe(Math.round(height) + BREATHING_PX);
      expect(document.documentElement.style.getPropertyValue(OFFSET_TOP_PROPERTY)).toBe(`${top}px`);
      // The reading line and the taps read the same property (`pageTrack` and `dom.ts`).
      expect(offsetTopOfPage(document)).toBe(top);
    }
  });
});

describe('the head publishes its own measurement', () => {
  it('writes --offset-top on mount, from the head it was given', async () => {
    // The head the hook measures: a fresh row, laid out at 59.1 px (a phone head with a chip).
    document.querySelectorAll('.top').forEach((node) => node.remove());
    const head = document.createElement('header');
    head.className = 'top';
    head.getBoundingClientRect = () => rect(0, 59.1);
    document.body.append(head);

    function Probe(): null {
      const ref = useRef<HTMLElement>(null);
      useStickyOffsets(ref);
      return null;
    }

    const host = document.body.appendChild(document.createElement('div'));
    const probe = createRoot(host);
    await act(async () => probe.render(<Probe />));
    expect(document.documentElement.style.getPropertyValue(OFFSET_TOP_PROPERTY)).toBe('67px');
    await act(async () => probe.unmount());
    host.remove();
  });
});
