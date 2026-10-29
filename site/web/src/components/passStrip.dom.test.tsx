// @vitest-environment jsdom
import type { PassStage, PassStageEvent, StageSpan } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import stripCss from '../styles/pass-strip.css?raw';
import tokensCss from '../styles/tokens.css?raw';
import { PassStrip, type PassStripProps } from './PassStrip.tsx';

/**
 * The pass strip (BOOK-167) under jsdom: 235 px of paper, a row per arrived stage, one
 * announcement per stage, and no word the owner banned. The facts are `passRail.test.ts`'s;
 * this file proves the mount, the one read per open and the copy.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const at = (iso: string): number => Date.parse(iso);
const T0 = at('2026-10-28T08:18:00Z');
const MIN = 60_000;

const SPAN: StageSpan[] = [
  { blockId: 'ch07#bbbb2222', before: 'Второй абзац до подхода писателя.', after: 'Второй абзац, переписанный на ходу.', truncated: false },
];

function event(stage: PassStage, seq: number, overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 7,
    stageSeq: seq,
    stage,
    at: T0 + seq * MIN,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: `строка ${String(seq)}`,
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

const LEAD: PassStageEvent[] = [
  event('queued', 1, { at: T0 }),
  event('read', 2, { at: T0, summary: 'читает главу 7' }),
  event('verdict', 3, { at: T0 + MIN, summary: 'сверяет с замыслом' }),
];

const answer = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** The page's motion preference: `false` unless a test asks for the still sheet. */
function motion(reduce: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  motion(false);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async () => answer({ stages: [] })));
});

afterEach(async () => {
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function draw(over: Partial<PassStripProps> = {}): Promise<HTMLDivElement> {
  const props: PassStripProps = {
    chapter: 7,
    events: LEAD,
    blockId: 'ch07#bbbb2222',
    now: T0 + 6 * MIN,
    onClose: () => undefined,
    ...over,
  };
  await act(async () => {
    root?.render(<PassStrip {...props} />);
  });
  await flush();
  return container!;
}

const text = (view: HTMLDivElement): string => view.textContent ?? '';
const rows = (view: HTMLDivElement): HTMLElement[] => [...view.querySelectorAll<HTMLElement>('.pass-row')];

describe('the pass strip’s anatomy', () => {
  it('is a 235 px block: the height is the token’s, and it is fixed', () => {
    expect(tokensCss).toMatch(/--pass-h:\s*235px/u);
    expect(stripCss).toMatch(/\.pass-strip\s*\{[^}]*height:\s*var\(--pass-h\)/u);
    // The seam's own frame: two hairlines, paper, no radius and no shadow.
    expect(stripCss).toMatch(/border-top:\s*1px solid var\(--rule-2\)/u);
    expect(stripCss).toMatch(/border-bottom:\s*1px solid var\(--rule\)/u);
    expect(stripCss).not.toMatch(/box-shadow|border-radius:\s*(?!0)/u);
    // No new colour: every ink in the sheet is a token.
    expect(stripCss).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('prints the live head verbatim and a row per stage', async () => {
    const view = await draw({
      events: [...LEAD, event('drafting', 4, { summary: 'пишет двенадцатый абзац' })],
      blocks: [{ id: 'ch07#aaaa1111' }, { id: 'ch07#bbbb2222' }],
    });
    const strip = view.querySelector('.pass-strip');
    expect(strip).not.toBeNull();
    // The height is the token's, not a literal: `--pass-h: 235px` (tokens.css).
    expect(strip?.getAttribute('data-phase')).toBe('live');
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('книга пишется\u00a0·\u00a0глава 7\u00a0·\u00a011:18');
    expect(view.querySelector('.pass-strip-id')?.textContent).toBe('№K4Q7');
    // Live: the current stage's word on the right; the paragraph is a fact in the live row.
    expect(view.querySelector('.pass-strip-right')?.textContent).toBe('пишет');
    expect(text(view)).toContain('абзац 2');
    // The live row stays 100 px: the word plus at most three fact lines.
    const facts = rows(view).at(-1)?.querySelectorAll('.pass-fact') ?? [];
    expect(facts.length).toBeLessThanOrEqual(3);
  });

  it('draws one row per arrived stage and none for a stage that has not arrived', async () => {
    const view = await draw();
    expect(rows(view).map((row) => row.dataset.row)).toEqual(['read', 'verdict']);
    expect(rows(view).map((row) => row.dataset.state)).toEqual(['done', 'live']);

    const empty = await draw({ events: [], now: T0 });
    expect(rows(empty)).toEqual([]);
    // No stored stage: the strip says the absence in words and claims no pass (BOOK-199).
    expect(empty.querySelector('.pass-strip')?.getAttribute('data-phase')).toBe('absent');
    expect(empty.querySelector('.pass-strip-heading')?.textContent).toBe('пока ничего не записано\u00a0·\u00a0глава 7');
    expect(empty.querySelector('.pass-strip-right')).toBeNull();
    expect(empty.querySelector('.pass-strip-receipt')).toBeNull();
  });

  it('prints the absence for a typing-only story — an empty rail never claims a pass', async () => {
    const view = await draw({ events: [event('typing', 5)], now: T0 + MIN });
    expect(rows(view)).toEqual([]);
    expect(view.querySelector('.pass-strip')?.getAttribute('data-phase')).toBe('absent');
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('пока ничего не записано\u00a0·\u00a0глава 7');
    expect(text(view)).not.toContain('книга пишется');
  });

  it('prints each row with its own stored moment', async () => {
    const view = await draw();
    const times = rows(view).map((row) => row.querySelector('.pass-row-time')?.textContent);
    // Both stored moments are 11:18 (the queue and the read share one); the verdict is 11:19.
    expect(times).toEqual(['11:18', '11:19']);
  });

  it('ends a refused rail in a dash and prints nothing below it', async () => {
    const view = await draw({ events: [...LEAD, event('refused', 4)] });
    const last = rows(view).at(-1);
    expect(last?.dataset.row).toBe('refused');
    expect(last?.dataset.state).toBe('refused');
    expect(last?.querySelector('.pass-row-dash')).not.toBeNull();
    expect(last?.querySelector('.pass-row-node')).toBeNull();
    expect(last?.textContent).toContain('не внесено');
    expect(view.querySelector('.pass-strip-receipt')).toBeNull();
  });

  it('prints a landed pass in the past tense with its receipt', async () => {
    const landed = event('landed', 4, {
      at: T0 + 5 * MIN,
      span: SPAN,
      tokens: { in: 120_000, out: 6_099 },
      costUsd: 0.08,
    });
    const view = await draw({ events: [...LEAD, event('drafting', 3, { at: T0 + 2 * MIN }), landed], now: T0 + 9 * MIN });
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('писалась\u00a0·\u00a0глава 7\u00a0·\u00a011:18');
    expect(view.querySelector('.pass-strip-right')?.textContent).not.toBeNull();
    expect(view.querySelector('.pass-strip-receipt')?.textContent).toContain('токенов');
    expect(view.querySelector('.pass-strip-receipt')?.textContent).not.toContain('цена');
  });

  it('prints «печатается» and who is printing when typing follows the landing', async () => {
    const landed = event('landed', 4, { at: T0 + 5 * MIN, span: SPAN });
    const view = await draw({
      events: [...LEAD, landed, event('typing', 5, { at: T0 + 5 * MIN + 2_000 })],
      now: T0 + 6 * MIN,
    });
    expect(rows(view).at(-1)?.dataset.state).toBe('live');
    expect(rows(view).at(-1)?.textContent).toContain('печатается');
    expect(text(view)).toContain('печатает браузер');
    // No model id, ever.
    expect(text(view)).not.toContain('deepseek');
  });

  it('closes with a real button and never stops the pass itself', async () => {
    const onClose = vi.fn();
    const view = await draw({ onClose });
    const close = view.querySelector('.pass-strip-close') as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    expect(close?.getAttribute('aria-label')).toBe('закрыть');
    await act(async () => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('the strip’s announcements and its motion', () => {
  it('announces one word per stage, never a character', async () => {
    const view = await draw();
    const status = (): string => view.querySelector('[role="status"]')?.textContent ?? '';
    expect(view.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(status()).toBe('сверяет');

    await draw({ events: [...LEAD, event('drafting', 4, { at: T0 + 2 * MIN, summary: 'пишет абзац' })] });
    expect(status()).toBe('пишет');

    const landed = event('landed', 5, { at: T0 + 3 * MIN, span: SPAN });
    await draw({ events: [...LEAD, landed, event('typing', 6, { at: T0 + 3 * MIN + 1_000 })] });
    expect(status()).toBe('печатается');
  });

  it('is a static list under reduced motion', async () => {
    motion(true);
    const view = await draw({ reduced: true });
    expect(view.querySelector('.pass-strip')?.getAttribute('data-motion')).toBe('still');
    // The stored times are still there: the list is legible without a single frame.
    expect(rows(view).map((row) => row.querySelector('.pass-row-time')?.textContent)).toEqual(['11:18', '11:19']);
    // Nothing of the pass renderer's carets can be in a rail.
    expect(view.querySelector('.caret-read')).toBeNull();
    expect(view.querySelector('.caret-write')).toBeNull();
  });
});

describe('the strip’s copy', () => {
  it('prints none of the words the owner removed', async () => {
    const landed = event('landed', 4, { at: T0 + 5 * MIN, span: SPAN, tokens: { in: 1_000, out: 99 }, costUsd: null });
    const view = await draw({ events: [...LEAD, landed, event('typing', 5, { at: T0 + 5 * MIN + 1_000 })], now: T0 + 6 * MIN });
    const copy = text(view).toLowerCase();
    for (const banned of ['проход', 'этап:', 'цена', 'deepseek', 'модель']) {
      expect(copy, `the strip prints «${banned}»`).not.toContain(banned);
    }
    for (const word of ['читает', 'сверяет', 'печатается']) {
      expect(copy, `the strip lost «${word}»`).toContain(word);
    }
    // A landing that is not printing keeps the past word: the strip never renames a fact.
    const settled = await draw({ events: [...LEAD, event('landed', 4, { at: T0 + 5 * MIN, span: SPAN })], now: T0 + 9 * MIN });
    expect(text(settled)).toContain('внесено');
  });
});

describe('the strip’s one read per open', () => {
  it('reads the pass’s earlier stages when the log lacks them', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => answer({ stages: LEAD }));
    vi.stubGlobal('fetch', fetchMock);
    const view = await draw({ events: [event('drafting', 4, { at: T0 + 2 * MIN })] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/chapters/7/stages');
    // The answer supplies the beginning: the rail now reads from «читает».
    expect(rows(view)[0]?.dataset.row).toBe('read');
  });

  it('reads nothing when the log already holds the pass’s beginning', async () => {
    const fetchMock = vi.fn(async () => answer({ stages: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await draw();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps one read for one open: a frame appends, it does not refetch', async () => {
    const fetchMock = vi.fn(async () => answer({ stages: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await draw({ events: [] });
    await draw({ events: [event('read', 1, { at: T0 })] });
    await draw({ events: [event('read', 1, { at: T0 }), event('verdict', 2, { at: T0 + MIN })] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
