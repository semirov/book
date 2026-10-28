// @vitest-environment jsdom
import { partOf, TOTAL_CHAPTERS, type CatalogEntry, type PassStage, type PassStageEvent, type StateSnapshot } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIDDOT } from '../lib/format.ts';
import { inFlightOf, type Stages, type StagesLog } from '../lib/useStages.ts';
import { Header } from './Header.tsx';
import { firstDeclarations, mediaBlocks, unionDeclarations } from './cssRules.ts';

/**
 * BOOK-156 #3814 — the book's state in the running head's free space, mounted in the real head.
 *
 * What is asserted here is the DOM contract and the geometry the sheets state:
 *
 *   - the line is a child of the head's one row, after the chapter cluster and before the folio;
 *   - live prints `книга пишется · глава 12 · 14:21` (and `пишется · 14:21` for the phone) with
 *     the 5×5 nib, stopped prints `движок остановлен · 14:21` without it, and idle prints
 *     nothing at all;
 *   - the region is announced once per *state change*, never per render;
 *   - the row cannot grow: the status is one 12 px line, and the row's tallest item is the
 *     brand's 13 px × 1.35 = 17.55 px label line (base.css). jsdom has no layout, so the height
 *     proof is read from the sheets here and measured in the browser in the delivery report.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** 14:21 in Moscow (UTC+3) — the site's one timezone. */
const AT = Date.parse('2026-10-28T11:21:00Z');

const STATE: StateSnapshot = {
  version: 1,
  at: '2026-10-28T11:21:20Z',
  engine: { status: 'running', heartbeatAt: '2026-10-28T11:21:05Z', laneId: 'forward' },
  phase: 'draft',
  front: { title: 'Бланк', about: null, rev: 1, updatedAt: '2026-10-28T10:00:00Z' },
  chapters: { total: TOTAL_CHAPTERS, written: [12], empty: [], count: 1, totalChars: 12_000, basis: [] },
  cursors: {
    forward: { lane: 'forward', from: 1, to: 21, cursor: 12, next: 13, status: 'writing', lastPassAt: null, lastPass: null },
    backward: { lane: 'backward', from: TOTAL_CHAPTERS, to: 22, cursor: TOTAL_CHAPTERS, next: TOTAL_CHAPTERS - 1, status: 'idle', lastPassAt: null, lastPass: null },
  },
  toc: [],
  meeting: { forwardFront: 12, backwardFront: TOTAL_CHAPTERS, gap: 0, converged: false, seam: 'not_reached' },
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

/** Chapter 12 carries prose, so the reading line names it and the folio prints its page. */
const CATALOG: CatalogEntry[] = Array.from({ length: TOTAL_CHAPTERS }, (_, index) => {
  const n = index + 1;
  return {
    n,
    part: partOf(n),
    title: n === 12 ? 'Комната на восьмом' : null,
    rev: n === 12 ? 2 : 0,
    chars: n === 12 ? 600 : 0,
    blocks: n === 12 ? 1 : 0,
    written: n === 12,
    basis: false,
    opening: null,
    writtenAt: n === 12 ? '2026-10-28T11:00:00Z' : null,
    updatedAt: n === 12 ? '2026-10-28T11:00:00Z' : null,
    direction: n <= 21 ? 'forward' : 'backward',
  } as CatalogEntry;
});

function event(stage: PassStage, seq: number): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 12,
    stageSeq: seq,
    stage,
    at: AT + (seq - 1) * 1_000,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: 'глава пишется',
    span: null,
    tokens: null,
    costUsd: null,
  };
}

/** The log and its in-flight fold, built the way the page builds them. */
function stagesOf(...events: PassStageEvent[]): Stages {
  const log: Record<number, PassStageEvent[]> = {};
  for (const one of events) (log[one.chapter] ??= []).push(one);
  const typed: StagesLog = log;
  return { log: typed, passes: inFlightOf(typed), note: () => undefined, reset: () => undefined };
}

let root: Root | null = null;
let container: HTMLDivElement;

/** Mount (or re-render) the real head with a log and a clock — the two facts the line reads. */
async function mount(options: { stages?: Stages; nowMs?: number } = {}): Promise<void> {
  await act(async () => {
    root?.render(
      <Header
        state={STATE}
        ribbon={null}
        catalog={CATALOG}
        markers={[]}
        onOpenChange={() => undefined}
        live
        stages={options.stages}
        nowMs={options.nowMs}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function status(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.head-status');
}

function textOf(selector: string): string | null {
  return container.querySelector(selector)?.textContent ?? null;
}

/** The head's one row of items, as their class names, in DOM order. */
function rowItems(): string[] {
  const row = container.querySelector('.top-row');
  return [...(row?.children ?? [])].map((child) => child.className);
}

beforeEach(async () => {
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
  // The chapter the reader is in: one slot at the top of the reading area, so `useReading`
  // names ch12 and the folio prints its page (the row's right end).
  const article = document.createElement('article');
  article.dataset.n = '12';
  article.dataset.rev = '2';
  article.getBoundingClientRect = () =>
    ({ top: 0, bottom: 90, height: 90, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;
  document.body.append(article);
  await mount({});
  await act(async () => {
    window.dispatchEvent(new Event('scroll'));
  });
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the head says the book is being written', () => {
  it('prints the full line, the phone’s line and the 5×5 nib while a pass is in flight', async () => {
    await mount({ stages: stagesOf(event('queued', 1), event('drafting', 2)), nowMs: AT + 20_000 });
    const line = status();
    expect(line).not.toBeNull();
    expect(line?.getAttribute('data-kind')).toBe('live');
    // Both variants are always in the markup: the sheet chooses, nothing is cut in JavaScript.
    expect(line?.querySelector('.head-status-full')?.textContent).toBe(
      `книга пишется${MIDDOT}глава 12${MIDDOT}14:21`,
    );
    expect(line?.querySelector('.head-status-short')?.textContent).toBe(`пишется${MIDDOT}14:21`);
    expect(line?.querySelector('.head-nib')).not.toBeNull();
    // One status region in the head, and no second name for a pass anywhere in it.
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.top')?.textContent ?? '').not.toContain('проход');
  });

  it('keeps the row: the status follows the chapter cluster and the folio follows the status', async () => {
    await mount({ stages: stagesOf(event('drafting', 2)), nowMs: AT + 20_000 });
    const items = rowItems();
    expect(items).toContain('brand');
    expect(items).toContain('top-chapter');
    expect(items).toContain('head-status');
    expect(items).toContain('folio');
    expect(items.indexOf('head-status')).toBeGreaterThan(items.indexOf('top-chapter'));
    expect(items.indexOf('folio')).toBeGreaterThan(items.indexOf('head-status'));
    // The chapter cluster still names the chapter: the status never takes the slot.
    expect(textOf('.top-chapter-n')).toBe('12');
  });

  it('prints nothing at all when no pass is in flight — the foot’s grip has that fact', async () => {
    await mount({ stages: stagesOf(event('drafting', 1), event('landed', 2)), nowMs: AT + 5_000 });
    expect(status()).toBeNull();
    expect(container.querySelector('.top')?.textContent ?? '').not.toContain('пишется');
    // ...and with no log at all, which is how PassRecordPage mounts the head.
    await mount({ nowMs: AT + 5_000 });
    expect(status()).toBeNull();
  });

  it('says the engine stopped — the word, the clock, and no nib — after 90 s of silence', async () => {
    await mount({ stages: stagesOf(event('drafting', 2)), nowMs: AT + 2_000 + 90_001 });
    const line = status();
    expect(line?.getAttribute('data-kind')).toBe('stopped');
    expect(line?.querySelector('.head-status-full')?.textContent).toBe(`движок остановлен${MIDDOT}14:21`);
    expect(line?.querySelector('.head-nib')).toBeNull();
  });
});

describe('the region speaks only when the state changes', () => {
  it('turns polite on the change of state, not on every render', async () => {
    // Idle: nothing is printed, and the region has heard that state.
    await mount({ stages: stagesOf(event('drafting', 1), event('landed', 2)), nowMs: AT + 20_000 });
    expect(status()).toBeNull();
    // A pass starts: the state changed, so the line is announced once…
    await mount({ stages: stagesOf(event('drafting', 3)), nowMs: AT + 20_000 });
    expect(status()?.getAttribute('aria-live')).toBe('polite');
    // …and a newer stage of the same pass is not a state change, so it is not read aloud again.
    await mount({ stages: stagesOf(event('drafting', 3), event('typing', 4)), nowMs: AT + 20_000 });
    expect(status()?.getAttribute('aria-live')).toBe('off');
    // The pass ends: the line goes, and the region is quiet again.
    await mount({ stages: stagesOf(event('drafting', 3), event('landed', 5)), nowMs: AT + 20_000 });
    expect(status()).toBeNull();
  });

  it('ends the silence on its own clock, with one timeout and no interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT + 2_000);
    await mount({ stages: stagesOf(event('drafting', 2)) });
    expect(status()?.getAttribute('data-kind')).toBe('live');
    await act(async () => {
      vi.advanceTimersByTime(90_002);
    });
    expect(status()?.getAttribute('data-kind')).toBe('stopped');
    expect(status()?.querySelector('.head-status-full')?.textContent).toBe(`движок остановлен${MIDDOT}14:21`);
  });
});

describe('the head’s height does not move', () => {
  it('is one 12 px line in a row whose tallest line is the brand’s 17.55 px', () => {
    const css = sheets['../styles/head-status.css'] ?? '';
    const line = firstDeclarations(css, '.head-status');
    expect(line).toContain('font-size: var(--fs-micro)');
    // The row's own 12 px label line: 1.35, exactly as `.folio` and the chapter slot carry it.
    expect(line).toContain('line-height: 1.35');
    expect(line).toContain('flex: none');
    expect(line).toContain('margin-inline-start: auto');
    expect(line).toContain('min-width: 0');
    // No box of its own: the 12 px label line *is* the element, so nothing is taller than it.
    expect(line).not.toMatch(/(?:^|;)\s*(?:min-)?height\s*:/u);
    expect(line).not.toMatch(/(?:^|;)\s*(?:min-)?inline-size\s*:/u);
    expect(line).not.toMatch(/(?:^|;)\s*padding/u);
    expect(line).not.toMatch(/(?:^|;)\s*border/u);
    // The row's tallest item is the brand: --fs-label (13 px) at line-height 1.35 = 17.55 px.
    const labels = unionDeclarations(sheets['../styles/base.css'] ?? '', '.top-row');
    expect(labels).toContain('font-size: var(--fs-label)');
    expect(labels).toContain('line-height: 1.35');
    expect(sheets['../styles/tokens.css'] ?? '').toContain('--fs-label: 13px');
    // 13 × 1.35 = 17.55 px against the status's 12 × 1.35 = 16.2 px: the row's height is the
    // brand's and the status cannot touch it.
    expect(13 * 1.35).toBeGreaterThan(12 * 1.35);
    // The folio's own box below 768 is 16.2 px — under the row's 17.55 px too, so it cannot be
    // what grows when the status appears (it is fixed and out of flow above 768).
    const folio = firstDeclarations(sheets['../styles/live.css'] ?? '', '.folio');
    expect(folio).toContain('font-size: var(--fs-micro)');
    expect(folio).toContain('line-height: 1.35');
    expect(folio).toContain('position: fixed');
    // The row is the column above 1024 too, or its items' `margin-inline-start: auto` would have
    // no free space to take (`.top-in` is a `space-between` flex row of one shrink-to-fit item).
    expect(unionDeclarations(css, '.top-in .top-row:first-child')).toContain('flex: 1');
  });

  it('never wraps and never ellipsizes: the phone prints the short phrase from the sheet', () => {
    const css = sheets['../styles/head-status.css'] ?? '';
    const line = firstDeclarations(css, '.head-status');
    expect(line).toContain('white-space: nowrap');
    expect(css).not.toMatch(/text-overflow/u);
    expect(css).not.toMatch(/ellipsis/u);
    expect(css).not.toMatch(/overflow/u);
    // The two variants swap at the one step the head already has.
    const phone = mediaBlocks(css, 'max-width: 767px').join('\n');
    expect(unionDeclarations(phone, '.head-status-full')).toContain('display: none');
    expect(unionDeclarations(phone, '.head-status-short')).toContain('display: inline');
    // On the phone the status owns the free space: the folio keeps the right end beside it.
    expect(
      unionDeclarations(phone, '.top-in .top-row:first-child:has(.head-status) .folio'),
    ).toContain('margin-inline-start: 0');
  });

  it('adds no ink of its own: the quiet ink and the pass’s one accent', () => {
    const css = sheets['../styles/head-status.css'] ?? '';
    // Comments name the ticket (`#3814`), not a colour: read the sheet the way the cascade does.
    const rules = css.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(firstDeclarations(css, '.head-status')).toContain('color: var(--ink-3)');
    expect(firstDeclarations(css, '.head-nib')).toContain('background: var(--live)');
    // A state is not an animation: no pulse, no fade, no transition — in a rule.
    expect(rules).not.toMatch(/animation|transition|@keyframes/u);
    expect(firstDeclarations(css, '.head-nib')).toContain('width: 5px');
    expect(firstDeclarations(css, '.head-nib')).toContain('height: 5px');
  });
});
