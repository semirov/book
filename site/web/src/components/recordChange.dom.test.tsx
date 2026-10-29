// @vitest-environment jsdom
import type { CatalogEntry, ChangeDto, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetChangeCache } from '../lib/changeCache.ts';
import type { ChangeLine } from '../lib/clientState.ts';
import { publishLiveChange, resetLiveChange } from '../lib/liveChange.ts';
import { resetPassStages } from '../lib/passStages.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { closeRecord, resetRecordMemory } from '../lib/record.ts';
import { anchorFor } from '../lib/seam.ts';
import { Record } from './Record.tsx';

/**
 * The change as a section of the sentence's record.
 *
 * A door (`?change=`, a thread's «правка →», the chronicle row) opens the record at the
 * sentence with the `правка` section expanded; an ordinary tap on a sentence does not carry a
 * change and gets no such section. The section's body is rows: the numeral is the header's
 * value, then the sentence before and after, the state word with its moment, the outcome and
 * one line per step. A failed read says so instead of leaving an empty body.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const AT = 1_764_000_000_000;
const BLOCK_ID = 'ch08#change';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет. Свет был включён до меня.';

const ENTRY: CatalogEntry = {
  n: 8,
  part: 2,
  title: 'Комната на восьмом',
  rev: 4,
  chars: 22_000,
  blocks: 40,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

const CHANGE: ChangeDto = {
  premiseLanded: false,
  id: 'chg_1',
  seq: 9,
  kind: 'accepted_comment',
  interventionKind: 'document',
  chapter: 8,
  intent: 'в комнате должен быть ровный свет',
  premise: false,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: null,
  cascade: null,
  modes: [],
  steps: [
    {
      seq: 1,
      wave: 0,
      wing: null,
      chapter: 8,
      pass: 'change',
      boundary: 8,
      outcome: 'rewritten',
      revBefore: 3,
      revAfter: 4,
      seamsIn: [],
      seamsOut: [],
      charsDelta: 41,
      note: null,
      at: '2026-10-25T12:00:00Z',
      cycles: 1,
      findingSurvived: false,
    },
  ],
  appliedRevs: [{ chapter: 8, rev: 4 }],
  cost: null,
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

function filing(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    attempt: null,
    id: 'cmt_1',
    number: 2,
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#2e6274',
    body: 'в комнате должен быть свет',
    interventionKind: 'document',
    proposedText: null,
    premise: false,
    status: 'applied',
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-25T12:04:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    changeId: 'chg_1',
    applied: { chapter: 8, rev: 4 },
    refusal: null,
    ...overrides,
  };
}

const anchor = anchorFor({ text: TEXT, blockId: BLOCK_ID, baseRev: ENTRY.rev, offset: TEXT.indexOf('Её') });

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  resetChangeCache();
  resetRecordMemory();
  resetLiveChange();
  resetPassStages();
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
});

afterEach(async () => {
  await act(async () => closeRecord());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetParagraphChainCache();
  resetChangeCache();
  resetRecordMemory();
});

async function frames(turns = 4): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }
}

async function mount(
  changeId: string | null,
  options: { filings?: CommentDto[]; changeQuote?: string | null } = {},
): Promise<void> {
  if (anchor === null) throw new Error('no anchor');
  await act(async () => {
    root?.render(
      <Record
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        start={anchor.sentence.start}
        end={anchor.sentence.end}
        word={null}
        anchor={anchor}
        frozen={null}
        writing={false}
        filings={options.filings ?? [filing()]}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        history
        changeId={changeId}
        changeQuote={options.changeQuote ?? null}
        onPosted={() => undefined}
        onClose={() => undefined}
      />,
    );
  });
  await frames();
}

function section(label: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('.rec-section')].find(
    (node) => node.querySelector('.rec-section-label')?.textContent === label,
  ) ?? null;
}

describe('the record’s `правка` section (a change, not a surface)', () => {
  it('is expanded on a change door and prints the numeral, the two sentences, state, time and steps', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/changes/chg_1')) {
          return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    await mount('chg_1');

    const header = section('правка');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    // The header's value is the change numeral, never a screen title.
    expect(header?.querySelector('.rec-section-count')?.textContent).toBe('009');
    expect(container.querySelector('.rec-change')?.getAttribute('data-change')).toBe('chg_1');

    const labels = [...container.querySelectorAll('.rec-change-label')].map((node) => node.textContent);
    expect(labels).toEqual(['было', 'стало']);
    expect(container.querySelector('.rec-change')?.textContent).toContain('«Её освещал яркий свет.»');
    // The record's own quote is the sentence as it stands now (the same filing here).
    const facts = [...container.querySelectorAll('.rec-change-facts')].map((node) => node.textContent);
    expect(facts[0]).toMatch(/^внесено · \d{2}\.\d{2}, \d{2}:\d{2}$/u);
    expect(facts[1]).toBe('внесено');
    expect([...container.querySelectorAll('.rec-change-step')].map((node) => node.textContent)).toEqual([
      'глава 8 переписана',
    ]);
  });

  it('has no `правка` section on an ordinary tap, and `замечания` stays the open one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    // Two filings: one is the record's own (it lives in the head), the other keeps `замечания`.
    await mount(null, { filings: [filing(), filing({ id: 'cmt_02', createdAt: '2026-10-20T09:14:00Z' })] });
    expect(section('правка')).toBeNull();
    expect(document.querySelector('.rec-change')).toBeNull();
    expect(section('замечания')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('prints the filing’s stored quote as «было» when the change rewrote its own sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/changes/chg_1')) {
          return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    // The live sentence carries no filing for the old wording: the before travels with the door.
    await mount('chg_1', { filings: [], changeQuote: 'Её освещал тусклый свет.' });
    const quotes = [...container.querySelectorAll('.rec-change-quote')].map((node) => node.textContent);
    expect(quotes).toEqual(['«Её освещал тусклый свет.»', '«Её освещал яркий свет.»']);
  });

  it('says a failed read instead of leaving an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await mount('chg_1');
    expect(section('правка')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.rec-change')).toBeNull();
    expect(container.querySelector('.rec-sections')?.textContent).toContain('правка не прочиталась');
  });

  /**
   * BOOK-220 B2 — the change's own frames are read where the change lives. One assertion per
   * frame: the section prints the queued place, the claim, the narrowed intent and the moved
   * basis, without a reload and without a second surface of its own.
   */
  it('prints the change’s own line for every change frame', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/changes/chg_1')) {
          return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    const cases: Array<[ChangeLine, string]> = [
      [{ kind: 'queued', at: AT, eventSeq: 1, ahead: 2, depth: 3 }, 'в очереди · впереди 2'],
      [{ kind: 'processing', at: AT, eventSeq: 2, ahead: 0, attempt: 1 }, 'идёт · попытка 1'],
      [{ kind: 'adapted', at: AT, eventSeq: 3, intent: 'ровный свет', reason: 'не про эту сцену' }, 'сужено · ровный свет · не про эту сцену'],
      [{ kind: 'stale', at: AT, eventSeq: 4, grade: 'weak', evidence: [], options: [] }, 'основа изменилась, решается заново'],
    ];
    for (const [line, word] of cases) {
      publishLiveChange({ lines: { chg_1: line }, passes: {} });
      await mount('chg_1');
      const live = container.querySelector('.rec-change-live');
      expect(live?.textContent, line.kind).toBe(word);
      expect(live?.getAttribute('data-line')).toBe(line.kind);
      await act(async () => root?.render(<></>));
      resetChangeCache();
      resetPassStages();
    }
  });

  /**
   * BOOK-220 B2/M3 — a closed pass is the writer's own sentence, and its stages are read back
   * for a reader who was not connected when it ran: one pass, on open, from the store.
   */
  it('prints the pass’s own sentence and reads that one pass’s stages on open', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/changes/chg_1')) {
          return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/api/chapters/8/stages')) {
          asked.push(url);
          return new Response(
            JSON.stringify({
              stages: [
                { passId: 'stp_1', chapter: 8, stageSeq: 1, stage: 'queued', at: AT, actor: { process: 'engine', model: null }, changeId: 'chg_1', summary: '', span: null, tokens: null, costUsd: null },
                { passId: 'stp_1', chapter: 8, stageSeq: 2, stage: 'refused', at: AT + 1_000, actor: { process: 'writer', model: null }, changeId: 'chg_1', summary: '', span: null, tokens: null, costUsd: null },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      }),
    );
    publishLiveChange({
      lines: {},
      passes: {
        stp_1: {
          stepId: 'stp_1',
          changeId: 'chg_1',
          chapter: 8,
          pass: 'change',
          outcome: 'refused',
          sentence: 'текст не менялся',
          at: AT,
          closeFailed: false,
          costUsd: null,
          tokens: null,
        },
      },
    });
    await mount('chg_1');
    expect(container.querySelector('.rec-change-pass')?.textContent).toBe('текст не менялся');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('pass=stp_1');
    expect(asked[0]).toContain('limit=50');
    expect([...container.querySelectorAll('.rec-change-stage')].map((node) => node.textContent)).toEqual([
      'в очереди',
      'отказ',
    ]);
    // The memo answers the second open: one pass is one read.
    await act(async () => root?.render(<></>));
    resetChangeCache();
    await mount('chg_1');
    expect(asked).toHaveLength(1);
  });

  it('says a pass’s stages could not be read instead of leaving an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/changes/chg_1')) {
          return new Response(JSON.stringify(CHANGE), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 500 });
      }),
    );
    publishLiveChange({
      lines: {},
      passes: {
        stp_1: {
          stepId: 'stp_1',
          changeId: 'chg_1',
          chapter: 8,
          pass: 'change',
          outcome: 'refused',
          sentence: 'текст не менялся',
          at: AT,
          closeFailed: false,
          costUsd: null,
          tokens: null,
        },
      },
    });
    await mount('chg_1');
    expect(container.querySelector('.rec-change-pass')?.textContent).toBe('текст не менялся');
    expect(container.querySelector('.rec-change-stages')).toBeNull();
    expect(container.textContent).toContain('ход правки не прочитался');
  });
});
