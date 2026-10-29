// @vitest-environment jsdom
import type { CatalogEntry, CommentDto, FilingUpdatePayload } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { publishFilingLive, resetFilingLive } from '../lib/filingLive.ts';
import { publishLiveChange, resetLiveChange } from '../lib/liveChange.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { closeRecord, resetRecordMemory } from '../lib/record.ts';
import { closeSeam } from '../lib/useSeam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { ProseParagraph } from './ProseParagraph.tsx';
import { tapAt } from './tap.fixture.ts';

/**
 * BOOK-220 §11.3 — «повторить» on the record.
 *
 * The word exists only for our failure (attempts spent, a provider or shape failure, a pass
 * rolled back), and one tap re-queues the same filing: `POST /api/comments/<id>/retry` once,
 * then the record reads the live state again while the failure stays in the trail. A lock, a
 * content refusal and the budget never offer it; a 404 is said out loud, never claimed as a
 * success.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BLOCK_ID = 'ch08#retry';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';
const QUOTE = 'Её освещал яркий свет.';

const ENTRY: CatalogEntry = {
  n: 8,
  part: 2,
  title: 'Комната на восьмом',
  rev: 3,
  chars: 22_000,
  blocks: 40,
  written: true,
  basis: false,
  opening: null,
  writtenAt: '2026-10-25T09:20:00Z',
  updatedAt: '2026-10-25T09:20:00Z',
  direction: 'forward',
};

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_retry',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    attempt: null,
    frame: null,
    premise: false,
    reason: null,
    createdAt: '2026-10-28T21:24:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    changeSeq: 12,
    ...overrides,
  };
}

/** The one wire answer this case controls: the repeat's own POST. */
let retryStatus = 200;
let retryCalls = 0;

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  resetRecordMemory();
  resetFilingLive();
  resetLiveChange();
  retryStatus = 200;
  retryCalls = 0;
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/retry')) {
        retryCalls += 1;
        return new Response('{}', { status: retryStatus });
      }
      return new Response('{}', { status: 404 });
    }),
  );
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
  resetFilingLive();
  resetLiveChange();
});

async function frames(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
    });
  }
}

async function mount(comments: readonly CommentDto[]): Promise<void> {
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId={BLOCK_ID}
        blockIndex={0}
        baseRev={ENTRY.rev}
        text={TEXT}
        blockCount={40}
        comments={comments}
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
        history
      />,
    );
  });
  await frames();
}

async function open(): Promise<void> {
  const span = [...document.querySelectorAll<HTMLElement>('.p [data-s]')][1];
  if (span === undefined) throw new Error('no sentence span');
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

const rec = (): HTMLElement | null => document.querySelector<HTMLElement>('.rec');

describe('«повторить» exists only for our failure', () => {
  it('offers the word for a provider or shape failure', async () => {
    await mount([comment({ attempt: 'failed' })]);
    await open();
    expect(document.querySelector('.rec-retry')?.textContent).toBe('повторить');
  });

  it('never offers it for a lock or a content refusal', async () => {
    await mount([comment({ status: 'rejected', refusal: 'rights', reason: 'не принято: пересказ' })]);
    await open();
    expect(rec()).not.toBeNull();
    expect(document.querySelector('.rec-retry')).toBeNull();
  });

  it('never offers it for the budget cap, and keeps the honest line', async () => {
    publishLiveChange({
      lines: {
        chg_budget: {
          kind: 'decided',
          at: 1,
          eventSeq: 1,
          payload: {
            id: 'chg_budget',
            commentId: 'cmt_retry',
            outcome: 'escalated',
            reason: null,
            chapters: [8],
            cascade: {
              id: 'csc_b',
              outcome: 'escalated:budget',
              waves: 3,
              touched: [8],
              rewritten: [8],
              wings: {
                down: { frontier: 8, wave: 3, state: 'stopped', reached: [8] },
                up: { frontier: 8, wave: 3, state: 'stopped', reached: [8] },
              },
              seams: [],
              finding: false,
            },
            relevance: null,
            tokens: { total: 0 },
            decidedAt: '2026-10-28T21:31:00Z',
            at: 1,
            eventSeq: 1,
          },
        },
      },
      passes: {},
    });
    await mount([comment({ status: 'rejected', changeId: 'chg_budget', reason: 'правка ушла глубже 2 волн' })]);
    await open();
    expect(document.querySelector('.rec-retry')).toBeNull();
  });

  it('hides the word when the cap is spent and says what is left', async () => {
    const update: FilingUpdatePayload = {
      commentId: 'cmt_retry',
      chapter: 8,
      state: 'new',
      attempts: 3,
      attemptsLeft: 0,
      changeId: null,
      at: 2,
    };
    publishFilingLive({ reading: null, filingUpdates: { cmt_retry: update }, decisions: {} });
    await mount([comment({ attempt: 'failed' })]);
    await open();
    expect(document.querySelector('.rec-retry')).toBeNull();
    expect(document.querySelector('.rec-retry-line')?.textContent).toBe('исчерпаны попытки — в следующий раз');
  });
});

describe('one tap re-queues the same filing', () => {
  it('calls the endpoint once and returns the record to the live state', async () => {
    await mount([comment({ attempt: 'failed', reason: 'модель ответила не по форме' })]);
    await open();
    await press('.rec-retry');
    expect(retryCalls).toBe(1);
    expect(rec()?.getAttribute('data-situation')).toBe('waiting');
    expect(document.querySelector('.rec-state')?.textContent).toContain('ждёт');
    expect(document.querySelector('.rec-state-line')?.textContent).toBe('повторяем с начала');
    expect(document.querySelector('.rec-retry')).toBeNull();
    // The failure stays in the trail, never erased by the repeat.
    const history = [...document.querySelectorAll<HTMLElement>('.rec-section')].find(
      (node) => node.querySelector('.rec-section-label')?.textContent === 'история',
    );
    if (history !== undefined) await press('.rec-section:last-of-type');
    const rows = [...document.querySelectorAll('.rec-row[data-kind="history"]')].map((node) => node.textContent ?? '');
    expect(rows.join(' ')).toContain('никто не внёс правку');
  });

  it('is one call for a double tap', async () => {
    await mount([comment({ attempt: 'failed' })]);
    await open();
    const button = document.querySelector<HTMLElement>('.rec-retry');
    await act(async () => {
      button?.click();
      button?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    await frames();
    expect(retryCalls).toBe(1);
  });

  it('is a word in the record’s register: no colour, no icon, lowercase', async () => {
    await mount([comment({ attempt: 'failed' })]);
    await open();
    const button = document.querySelector<HTMLElement>('.rec-retry');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.textContent).toBe('повторить');
    expect(button?.querySelector('svg, img')).toBeNull();
  });

  it('says the honest thing when the endpoint answers 404, and never claims a success', async () => {
    retryStatus = 404;
    await mount([comment({ attempt: 'failed', reason: 'модель ответила не по форме' })]);
    await open();
    await press('.rec-retry');
    expect(retryCalls).toBe(1);
    expect(document.querySelector('.rec-state-line')?.textContent).toContain('модель ответила не по форме');
    expect(document.querySelector('.rec-retry-line')?.textContent).toBe('повтор недоступен');
    expect(rec()?.textContent).not.toContain('повторяем с начала');
  });
});
