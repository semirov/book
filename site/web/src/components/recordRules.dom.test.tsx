// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { resetParagraphChainCache } from '../lib/paragraphChainCache.ts';
import { closeRecord, resetRecordMemory } from '../lib/record.ts';
import { closeSeam } from '../lib/useSeam.ts';
import { hideFiling } from '../lib/useFiling.ts';
import { ProseParagraph } from './ProseParagraph.tsx';
import { tapAt } from './tap.fixture.ts';

/**
 * BOOK-220 §11.3 — one filing once per screen, one action per screen.
 *
 * The owner's phone: `№4НТ №4НТ` in the margin, `отклонено` in the head, and the same filing's
 * row in `замечания` — one filing printed three times. These claims are DOM counts, not looks:
 * one `вмешаться` node while a record is open, one margin number for one filing, and the
 * record's own filing absent from the list it is open over.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

const BLOCK_ID = 'ch08#rules';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет. Свет был включён до меня.';
const QUOTE = 'Её освещал яркий свет.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: null,
    status: 'new',
    refusal: null,
    attempt: null,
    frame: null,
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetParagraphChainCache();
  resetRecordMemory();
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
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
});

async function frames(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
    });
  }
}

async function mount(comments: readonly CommentDto[] = []): Promise<void> {
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

async function tapSentence(index = 1): Promise<void> {
  const span = [...document.querySelectorAll<HTMLElement>('.p [data-s]')][index];
  if (span === undefined) throw new Error('no sentence span');
  await act(async () => {
    tapAt(span);
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
  await frames();
}

const rec = (): HTMLElement | null => document.querySelector<HTMLElement>('.rec');


/**
 * §11.3 — one filing once per screen, and one action per screen.
 *
 * The owner's phone: `№4НТ №4НТ` in the margin, `отклонено` in the head, and the same filing's
 * row in `замечания` — one filing printed three times. These claims are DOM counts, not looks:
 * one `вмешаться` node while a record is open, one margin number for one filing, and the
 * record's own filing absent from the list it is open over.
 */
describe('one filing, one action', () => {
  const words = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>('button, span')].filter(
      (node) => node.textContent?.trim() === 'вмешаться',
    );

  it('an open record renders exactly one `вмешаться` node', async () => {
    await mount([comment({ changeSeq: 12 })]);
    await tapSentence(1);
    expect(rec()).not.toBeNull();
    expect(words()).toHaveLength(1);
    expect(words()[0]?.className).toContain('rec-cta');
    // The margin's rail is not a second one: the record's own word is the act.
    expect(document.querySelector('.seam-rail')).toBeNull();
  });

  it('a closed record with a marked sentence renders exactly one `вмешаться` node', async () => {
    await mount([comment({ changeSeq: 12 })]);
    expect(words()).toHaveLength(1);
    expect(words()[0]?.className).toContain('seam-rail');
  });

  it('the margin prints one number per filing, never a token', async () => {
    await mount([comment({ changeSeq: 12 })]);
    const paragraph = document.querySelector('.p');
    const marks = [...(paragraph?.querySelectorAll('.filing-mark') ?? [])];
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('012');
    expect(marks[0]?.getAttribute('data-number')).toBe('правка 012');
    // The note beside it says the state, not the number again; the margin prints no token.
    const note = paragraph?.querySelector('.margin-note');
    expect(note?.textContent).not.toContain('012');
    const margin = [...(paragraph?.querySelectorAll('.filing-mark, .margin-note') ?? [])];
    const marginText = margin.map((node) => node.textContent ?? '').join(' ');
    expect(marginText).not.toContain('№');
    expect(marginText.match(/012/gu) ?? []).toHaveLength(1);
  });

  it('leaves the record’s own filing out of `замечания`, and lists only the others', async () => {
    await mount([comment({ changeSeq: 12 }), comment({ id: 'cmt_02J9Z8K4Q7', changeSeq: 13, createdAt: '2026-10-20T09:14:00Z' })]);
    await tapSentence(1);
    const rows = [...document.querySelectorAll('.rec-row')].map((node) => node.textContent ?? '');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('правка 013');
    // The filing the record is open for lives in the head: its number and its state, once.
    const head = document.querySelector('.rec-state')?.textContent ?? '';
    expect(head).toContain('правка 012');
    expect(head).toContain('ждёт');
    expect(rows.join(' ')).not.toContain('правка 012');
  });
});
