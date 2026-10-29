// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { closeRecord, currentRecord, resetRecordMemory } from '../lib/record.ts';
import { ProseParagraph } from './ProseParagraph.tsx';

/**
 * BOOK-90 AC2 — the interaction at the sentence is the **record**.
 *
 * An accepted tick and a margin note open the same register under the paragraph, with the
 * filing's body as its open one; there is no separate object, no second close and no panel.
 * `Escape` closes the record (the record's own contract), and opening another filing moves the
 * record to that sentence.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

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
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 1, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: null,
    interventionKind: 'testimony',
    status: 'new',
    frame: 'untouched',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  resetRecordMemory();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  viStubMotion();
});

afterEach(async () => {
  await act(async () => closeRecord());
  if (root !== null) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  resetRecordMemory();
});

function viStubMotion(): void {
  Object.assign(globalThis, {
    matchMedia: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

async function mount(comments: readonly CommentDto[], text = TEXT): Promise<void> {
  await act(async () => {
    root?.render(
      <ProseParagraph
        entry={ENTRY}
        blockId="ch08#aa11bb22"
        blockIndex={1}
        baseRev={3}
        text={text}
        blockCount={1}
        comments={comments}
        history
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={() => undefined}
      />,
    );
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function click(selector: string): Promise<void> {
  const element = container.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  await act(async () => element.click());
  await settle();
}

describe('the filing’s sentence opens its record', () => {
  it('opens the record from the accepted tick, with the filing’s body as the open one', async () => {
    await mount([comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })]);
    await click('.filing-tick');
    const record = container.querySelector<HTMLElement>('.rec');
    expect(record).not.toBeNull();
    expect(record?.getAttribute('data-body')).toBe('filing');
    expect(record?.textContent).toContain('в комнате должен быть свет, но не от лампы');
    expect(container.querySelector('.revision')).toBeNull();
    expect(container.querySelector('.filing-panel')).toBeNull();
  });

  it('opens the same record from the margin note', async () => {
    await mount([comment({ status: 'new' })]);
    await click('.margin-note');
    const record = container.querySelector<HTMLElement>('.rec');
    expect(record?.getAttribute('data-body')).toBe('filing');
    expect(currentRecord()?.filing?.id).toBe('cmt_01J9Z8K4Q7');
  });

  it('prints «было» and «стало» when the book rewrote the filed sentence', async () => {
    await mount([
      comment({
        anchor: { ...comment().anchor, quote: 'Её освещал тусклый свет.', prefix: 'Я вошёл в пустую комнату. ', suffix: '' },
      }),
    ]);
    await click('.margin-note');
    const rows = [...container.querySelectorAll('.rec-change-row')].map((node) => node.textContent);
    expect(rows).toEqual(['было«Её освещал тусклый свет.»', 'стало«Её освещал яркий свет.»']);
  });

  it('Escape closes the record, and the paragraph keeps its lines', async () => {
    await mount([comment()]);
    await click('.margin-note');
    expect(container.querySelector('.rec')).not.toBeNull();
    // The filing's body is the first layer: Escape puts it away, the second closes the block.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await settle();
    expect(document.querySelector('.rec')?.getAttribute('data-body')).toBe('list');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await settle();
    expect(document.querySelector('.rec')).toBeNull();
    expect(document.querySelector('.p')?.textContent).toContain('Её освещал яркий свет.');
  });
});
