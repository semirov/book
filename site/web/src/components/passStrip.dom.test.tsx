// @vitest-environment jsdom
import type { PassStage, PassStageEvent } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import stripCss from '../styles/pass-strip.css?raw';
import { PassStrip, type PassStripProps } from './PassStrip.tsx';

/**
 * The pass strip is one plain sentence in the book's voice, not the engine's report card.
 *
 * Live: «глава 7 пишется». Ended: «глава 7 писалась». A failed read: «не удалось прочитать
 * ход». There is no rail, no stage word, no duration and no token or money line anywhere in
 * it — that vocabulary belongs to the operator's console.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const at = (iso: string): number => Date.parse(iso);
const T0 = at('2026-10-28T08:18:00Z');
const MIN = 60_000;

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
    tokens: { in: 120_000, out: 66_411 },
    costUsd: 0.19,
    ...overrides,
  };
}

const READING: PassStageEvent[] = [event('queued', 1, { at: T0 }), event('read', 2, { at: T0 })];

const answer = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
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
    onClose: () => undefined,
    ...over,
  };
  await act(async () => {
    root?.render(<PassStrip {...props} />);
  });
  await flush();
  return container!;
}

const LEAD: PassStageEvent[] = [...READING, event('drafting', 4)];

const text = (view: HTMLDivElement): string => view.textContent ?? '';

describe('the pass strip’s one sentence', () => {
  it('says the chapter is being written, in the book’s voice, and nothing else', async () => {
    const view = await draw();
    const strip = view.querySelector<HTMLElement>('.pass-strip');
    expect(strip?.getAttribute('data-phase')).toBe('live');
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('глава 7 пишется');
    expect(view.querySelectorAll('.pass-row')).toHaveLength(0);
    expect(view.querySelector('.pass-strip-rail')).toBeNull();
    expect(view.querySelector('.pass-strip-receipt')).toBeNull();
    // No engine vocabulary: no stage, no duration, no money, no token.
    for (const gone of ['токен', '₽', '$', 'мин', 'сек', 'ждал', 'читал', 'писал', 'сверял', 'внёс', 'не принял', 'печатник']) {
      expect(text(view), gone).not.toContain(gone);
    }
  });

  it('reads a landed pass in the past tense and prints no duration', async () => {
    const view = await draw({ events: [...READING, event('landed', 5)] });
    expect(view.querySelector('.pass-strip')?.getAttribute('data-phase')).toBe('ended');
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('глава 7 писалась');
    expect(text(view)).not.toMatch(/\d+\s*мин/u);
  });

  it('says a refused pass did not write the chapter', async () => {
    const view = await draw({ events: [...READING, event('refused', 5)] });
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('глава 7 не писалась');
    expect(text(view)).not.toContain('печатается');
  });

  it('says it could not read the pass, with no invented stage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const view = await draw({ events: [] });
    expect(view.querySelector('.pass-strip')?.getAttribute('data-phase')).toBe('unread');
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('не удалось прочитать ход');
    expect(view.querySelectorAll('.pass-row')).toHaveLength(0);
    expect(text(view)).not.toContain('пишется');
  });

  it('stays a block in the flow: one close, no shadow, no fixed position, serif sentence', () => {
    expect(stripCss).toMatch(/\.pass-strip\s*\{[^}]*border-top:\s*1px solid var\(--rule-2\)/u);
    expect(stripCss).toMatch(/\.pass-strip\s*\{[^}]*background:\s*var\(--paper-2\)/u);
    expect(stripCss).not.toMatch(/position:\s*fixed/u);
    expect(stripCss).not.toMatch(/box-shadow|border-radius:\s*(?!0)/u);
    expect(stripCss).toMatch(/\.pass-strip-heading\s*\{[^}]*font-family:\s*var\(--serif\)/u);
    expect(stripCss).not.toContain('.pass-row');
    expect(stripCss).not.toContain('.pass-strip-receipt');
  });

  it('reads the log once per open when the page holds no stage of it', async () => {
    const fetchMock = vi.fn(async () => answer({ stages: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const view = await draw({ events: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view.querySelector('.pass-strip-heading')?.textContent).toBe('глава 7 пишется');
  });
});
