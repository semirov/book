// @vitest-environment jsdom
import {
  partOf,
  STAGE_DEADLINE_MS,
  TOTAL_CHAPTERS,
  type CatalogEntry,
  type LivePass,
  type StateSnapshot,
} from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Header } from './Header.tsx';
import { firstDeclarations, unionDeclarations } from './cssRules.ts';

/**
 * BOOK-207 / BOOK-DOC-84 D3 — the head's one word, mounted in the real head.
 *
 * What is asserted here is the DOM contract and the geometry the sheets state:
 *
 *   - the line is a child of the head's one row, after the chapter cluster and before the folio;
 *   - the word is the stage's own (`сейчас читает` / `пишется` / `проверяют` / `записывает`),
 *     the quiet word carries no nib, and idle prints nothing at all;
 *   - the row cannot grow: the status is one 12 px line, and the row's items are all the same
 *     12 px × 1.35 = 16.2 px box (base.css's `.top-row`). jsdom has no layout, so the height
 *     proof is read from the sheets here.
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
  cursors: {} as StateSnapshot['cursors'],
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

const PASS: LivePass = {
  chapter: 12,
  passId: 'stp_01J9Z8K4Q7',
  changeId: null,
  lane: 'forward',
  stage: 'drafting',
  stageSeq: 2,
  since: AT + 1_000,
  deadlineAt: AT + 1_000 + STAGE_DEADLINE_MS,
};

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(
  options: {
    passes?: readonly LivePass[];
    engine?: { status: StateSnapshot['engine']['status'] } | null;
    appliedAt?: number | null;
    nowMs?: number;
    /** A page hands no clock in: the component reads `Date.now` (a fake clock in the test). */
    live?: boolean;
  } = {},
): Promise<void> {
  await act(async () => {
    root?.render(
      <Header
        state={STATE}
        ribbon={null}
        catalog={CATALOG}
        markers={[]}
        onOpenChange={() => undefined}
        live
        passes={options.passes}
        engine={options.engine}
        appliedAt={options.appliedAt}
        nowMs={options.live === true ? undefined : (options.nowMs ?? AT + 20_000)}
        reading={{ n: 12, page: 1 }}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const status = (): HTMLElement | null => container.querySelector<HTMLElement>('.head-status');
const word = (): string | null => container.querySelector('.head-status-full')?.textContent ?? null;

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
  const article = document.createElement('article');
  article.dataset.n = '12';
  article.dataset.rev = '2';
  article.getBoundingClientRect = () =>
    ({ top: 0, bottom: 90, height: 90, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;
  document.body.append(article);
  await mount();
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the head names what the machine is doing', () => {
  it('prints the stage’s word and the 5×5 nib while a pass is in flight', async () => {
    await mount({ passes: [{ ...PASS, stage: 'drafting' }] });
    expect(status()?.getAttribute('data-kind')).toBe('writing');
    expect(word()).toBe('сейчас пишется');
    expect(status()?.querySelector('.head-nib')).not.toBeNull();
  });

  it('changes the word with the stage, without a reload', async () => {
    const stages: Array<[LivePass['stage'], string]> = [
      ['queued', 'сейчас читает'],
      ['drafting', 'сейчас пишется'],
      ['verdict', 'сейчас проверяют'],
    ];
    for (const [stage, expected] of stages) {
      await mount({ passes: [{ ...PASS, stage }] });
      expect(word()).toBe(expected);
    }
    await mount({ passes: [{ ...PASS, stage: 'verdict' }], appliedAt: AT + 20_000 });
    expect(word()).toBe('сейчас записывает');
  });

  it('keeps the row: the status follows the chapter cluster and the folio follows the status', async () => {
    await mount({ passes: [PASS] });
    const items = rowItems();
    expect(items.indexOf('head-status')).toBeGreaterThan(items.indexOf('top-chapter'));
    expect(items.indexOf('folio')).toBeGreaterThan(items.indexOf('head-status'));
    expect(container.querySelector('.top-chapter-n')?.textContent).toBe('12');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('.top')?.textContent ?? '').not.toContain('проход');
  });

  it('prints nothing at all when no pass is open — idle is absent, not «тихо»', async () => {
    await mount({ passes: [] });
    expect(status()).toBeNull();
  });

  it('goes quiet past the pass’s own deadline, without a look at the clock by the reader', async () => {
    await mount({ passes: [PASS], nowMs: PASS.since + STAGE_DEADLINE_MS + 1 });
    expect(status()?.getAttribute('data-kind')).toBe('quiet');
    expect(word()).toBe('сейчас тихо');
    expect(status()?.querySelector('.head-nib')).toBeNull();
  });

  it('goes quiet when the engine is down, whatever a stage says', async () => {
    await mount({ passes: [PASS], engine: { status: 'down' } });
    expect(word()).toBe('сейчас тихо');
  });

  it('ends the word on its own clock, with one timeout and no interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(PASS.since + 1_000);
    await mount({ passes: [PASS], live: true });
    expect(word()).toBe('сейчас пишется');
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    await act(async () => {
      vi.advanceTimersByTime(STAGE_DEADLINE_MS);
    });
    expect(word()).toBe('сейчас тихо');
  });
});

describe('the head’s height does not move', () => {
  it('is one 12 px line in a row whose tallest line is the brand’s 16.2 px', () => {
    const css = sheets['../styles/head-status.css'] ?? '';
    const line = firstDeclarations(css, '.head-status');
    expect(line).toContain('font-size: var(--fs-micro)');
    expect(line).toContain('line-height: 1.35');
    expect(line).toContain('flex: none');
    expect(line).toContain('margin-inline-start: auto');
    expect(line).toContain('text-transform: none');
    expect(line).not.toMatch(/(?:^|;)\s*(?:min-)?height\s*:/u);
    expect(line).not.toMatch(/(?:^|;)\s*padding/u);
    expect(sheets['../styles/tokens.css'] ?? '').toContain('--fs-micro: 12px');
    expect(unionDeclarations(sheets['../styles/running-head.css'] ?? '', '.top-chapter')).toContain(
      'font-size: var(--fs-micro)',
    );
    // The row is the column above 1024 too, or its `margin-inline-start: auto` has no free space.
    expect(unionDeclarations(css, '.top-in .top-row:first-child')).toContain('flex: 1');
  });
});
