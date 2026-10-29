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
 * BOOK-128 #3863 / #3862 — the sentence's record.
 *
 * The jsdom claims are the contract the browser cannot make: one block, one close, one open
 * section, the sentence as the door (no `…` anywhere), the untouched record's single line, the
 * form and the receipt as states of the same body, a draft that survives, and the keyboard
 * shape (one tab stop, arrows, Enter as the toggle). The browser's facts are the CDP harness's.
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

const BLOCK_ID = 'ch08#record';
const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет. Свет был включён до меня.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: BLOCK_ID, blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
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

const chain = (versions: number): string => {
  const rows = [
    {
      blockUid: 'u1',
      ver: 1,
      blockId: BLOCK_ID,
      chapter: 8,
      rev: 1,
      at: '2026-10-21T12:03:00Z',
      op: 'introduced',
      textHash: 'h',
      chars: 10,
      changeId: null,
      changeSeq: null,
      stepId: null,
      actor: { kind: 'writer', label: 'печатник', identityId: 'id1' },
      replacedBy: null,
    },
    {
      blockUid: 'u1',
      ver: 2,
      blockId: BLOCK_ID,
      chapter: 8,
      rev: 2,
      at: '2026-10-28T12:08:00Z',
      op: 'revised',
      textHash: 'h2',
      chars: 10,
      changeId: 'chg_12',
      changeSeq: 12,
      stepId: null,
      actor: { kind: 'writer', label: 'печатник', identityId: 'id1' },
      replacedBy: null,
    },
  ].slice(0, versions);
  return JSON.stringify({ blockUid: 'u1', blockId: BLOCK_ID, chapter: 8, alive: true, versions: rows, line: 'печатник' });
};

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
  // An answered-empty chain: the record quotes its sentence, and no height arrives later.
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

/** A tap on the nth sentence: the sentence **is** the unit (ADR-044); the whole gesture is sent. */
async function tapSentence(index = 1): Promise<HTMLElement> {
  const span = [...document.querySelectorAll<HTMLElement>('.p [data-s]')][index];
  if (span === undefined) throw new Error('no sentence span');
  await act(async () => {
    tapAt(span);
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
  await frames();
  return span;
}

const rec = (): HTMLElement | null => document.querySelector<HTMLElement>('.rec');
async function press(selector: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  await act(async () => {
    element.click();
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
  await frames();
}

function typeInto(selector: string, value: string): void {
  const element = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
  if (element === null) throw new Error(`no ${selector}`);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  act(() => element.dispatchEvent(new Event('input', { bubbles: true })));
}

describe('the record: the sentence is the door', () => {
  it('opens the sentence’s record for a tap anywhere in it, and marks that sentence', async () => {
    await mount();
    expect(rec()).toBeNull();

    const sentence = await tapSentence(1);
    const block = rec();
    expect(block).not.toBeNull();
    expect(block?.getAttribute('data-acc')).toBe('open');
    expect(document.querySelectorAll('.rec')).toHaveLength(1);
    expect(document.querySelectorAll('.rec-close')).toHaveLength(1);
    // The paragraph is untouched, and the block is its next sibling.
    expect(document.querySelector('p.p')?.nextElementSibling).toBe(block);
    expect(document.querySelector('p.p')?.contains(block ?? null)).toBe(false);
    // The mark is the sentence's own door — the same node, decoration only.
    const door = sentence.querySelector<HTMLElement>('.sentence-door');
    expect(door?.getAttribute('data-touch')).not.toBeNull();
    expect(door?.getAttribute('aria-expanded')).toBe('true');
    expect(door?.getAttribute('aria-controls')).toBe(block?.id);
    // ADR-044 — no ellipsis control stands at the paragraph's end any more.
    expect(document.querySelector('.prov')).toBeNull();
    expect(document.querySelector('.p')?.textContent).not.toContain('…');
    expect(document.querySelector('.p')?.textContent).not.toContain('⋯');
  });

  it('a word tap and a sentence tap open the same record, and only the word is underlined', async () => {
    await mount();
    // A sentence tap: the same record, and the word under the caret is the sentence's first.
    await tapSentence(1);
    const first = rec()?.id;
    expect(first).toBeTruthy();
    expect(document.querySelector('.rec-word')).not.toBeNull();

    // A second tap on the open sentence is its toggle.
    await press('.rec-close');
    await frames(8);
    expect(rec()).toBeNull();
    // A **word** tap: the caret is stubbed where the browser would place it, inside «яркий».
    const span = [...document.querySelectorAll<HTMLElement>('.p [data-s]')][1];
    const node = span?.querySelector('.sentence-door')?.firstChild ?? span?.firstChild;
    if (node === null || node === undefined) throw new Error('no text node');
    const at = (span?.textContent ?? '').indexOf('яркий');
    expect(at).toBeGreaterThan(0);
    const doc = document as unknown as {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    doc.caretPositionFromPoint = () => ({ offsetNode: node, offset: at + 1 });
    await act(async () => {
      tapAt(span as HTMLElement);
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    await frames();
    expect(rec()?.id).toBe(first);
    expect(document.querySelector('.rec-word')?.textContent).toBe('яркий');
    // One block, one mark: the word is decoration inside the quote, not a second surface.
    expect(document.querySelectorAll('.rec')).toHaveLength(1);
    expect(document.querySelectorAll('.rec-word')).toHaveLength(1);
  });

  it('closes on ✕ and on Escape, and hands focus back to the sentence', async () => {
    await mount();
    const sentence = await tapSentence(1);
    await press('.rec-close');
    await frames(8);
    expect(rec()).toBeNull();
    const quiet = document.querySelector<HTMLElement>('[data-touch]');
    expect(quiet).toBe(sentence.querySelector('.sentence-door'));
    expect(quiet?.getAttribute('data-mark')).toBe('last');
    expect(document.activeElement).toBe(quiet);

    await tapSentence(1);
    expect(rec()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    await frames(8);
    expect(rec()).toBeNull();
  });

  it('swaps to another sentence in one commit: one block, one close', async () => {
    await mount();
    await tapSentence(1);
    const first = rec();
    await tapSentence(2);
    expect(document.querySelectorAll('.rec')).toHaveLength(1);
    expect(document.querySelectorAll('.rec-close')).toHaveLength(1);
    expect(rec()).not.toBe(first);
    expect(document.querySelectorAll('[data-touch]')).toHaveLength(1);
  });

  it('keeps the draft across a close and a reopen of the same sentence', async () => {
    await mount();
    await tapSentence(1);
    await press('.rec-cta');
    expect(document.querySelector('.seam-form')).not.toBeNull();
    typeInto('textarea.seam-text', 'Черновик, который не должен переехать.');
    await press('.rec-close');
    await frames(8);
    await tapSentence(1);
    await press('.rec-cta');
    expect(document.querySelector<HTMLTextAreaElement>('textarea.seam-text')?.value).toBe(
      'Черновик, который не должен переехать.',
    );
  });

  it('the form is a state of the same body: the head row says `вмешаться`, one ✕ stays', async () => {
    await mount();
    await tapSentence(1);
    const before = rec()?.id;
    await press('.rec-cta');
    expect(rec()?.id).toBe(before);
    expect(rec()?.getAttribute('data-body')).toBe('form');
    expect(document.querySelector('.rec-act-word')?.textContent).toBe('вмешаться');
    expect(document.querySelector('.rec-cta')).toBeNull();
    expect(document.querySelectorAll('.rec-close')).toHaveLength(1);
    expect(document.querySelectorAll('.rec-section')).toHaveLength(0);
  });

  it('the untouched sentence prints exactly one line and no headers', async () => {
    await mount();
    await tapSentence(1);
    expect(document.querySelector('.rec-empty')?.textContent).toBe('с тех пор её никто не трогал');
    expect(document.querySelectorAll('.rec-section')).toHaveLength(0);
    expect(rec()?.textContent).not.toMatch(/\b0\b/u);
    expect(document.querySelector('.rec-cta')?.textContent).toBe('вмешаться');
    expect(document.querySelectorAll('.rec-close')).toHaveLength(1);
  });

  it('prints the sections in the order of the design: quote, hand, head, замечания, история', async () => {
    await mount([comment()]);
    await tapSentence(1);
    const sheet = document.querySelector('.rec-sheet');
    const order = [...(sheet?.children ?? [])].map((node) => node.className);
    expect(order[0]).toContain('rec-quote');
    expect(order[1]).toContain('rec-hand');
    expect(order[2]).toContain('rec-head');
    // An answered-empty chain has no history to print: a section with nothing is not a section.
    const sections = [...document.querySelectorAll('.rec-section-label')].map((node) => node.textContent);
    expect(sections).toEqual(['замечания']);
    // `связи` is not rendered: the ledger has no route, and a door to an empty room is worse.
    expect(document.querySelector('.rec-section[data-label="relations"]')).toBeNull();
  });

  it('keeps one section open at a time, with the count on the closed header', async () => {
    await mount([
      comment({ id: 'cmt_A7K' }),
      comment({ id: 'cmt_B2M', createdAt: '2026-10-20T09:14:00Z' }),
    ]);
    await tapSentence(1);
    const headers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.rec-section')];
    expect(headers()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.rec-row')).toHaveLength(2);
    // A count of one is not printed; two is.
    expect(headers()[0]?.querySelector('.rec-section-count')?.textContent).toBe('2');
    // A header toggles: pressing the open one closes it, and pressing it again opens it.
    await press('.rec-section');
    expect(headers()[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('.rec-row')).toHaveLength(0);
    await press('.rec-section');
    expect(headers()[0]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('prints the history section, its rows and the pair’s honest absence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(chain(2), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    await mount([comment()]);
    await tapSentence(1);
    await frames();
    const labels = [...document.querySelectorAll('.rec-section-label')].map((node) => node.textContent);
    // `замечания` from the filing, `история` from the chain.
    expect(labels).toEqual(['замечания', 'история']);
    await press('.rec-section:last-of-type');
    const row = document.querySelector('.rec-row[data-kind="history"]');
    expect(row?.textContent).toContain('печатник');
    expect(row?.textContent).toContain('правка 012');
    expect(row?.textContent).toContain('пара не записана');
  });

  it('prints no `замечания` header when the sentence holds no filing', async () => {
    await mount();
    await tapSentence(1);
    // `внесено · правка 012` from the chain, no filings: no header, no zero, no empty list.
    expect(document.querySelectorAll('.rec-section')).toHaveLength(0);
    expect(rec()?.textContent).not.toContain('замечания');
  });

  it('renders `история` for a one-version sentence, with no count (never a count of one)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(chain(1), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    await mount();
    await tapSentence(1);
    await frames();
    expect([...document.querySelectorAll('.rec-section-label')].map((node) => node.textContent)).toContain('история');
    const header = [...document.querySelectorAll<HTMLElement>('.rec-section')].find(
      (node) => node.querySelector('.rec-section-label')?.textContent === 'история',
    );
    expect(header?.querySelector('.rec-section-count')).toBeNull();
    await press('.rec-section:last-of-type');
    expect(document.querySelectorAll('.rec-row[data-kind="history"]')).toHaveLength(1);
  });

  it('leaves a filing numeral’s Enter to the numeral', async () => {
    await mount([comment()]);
    await tapSentence(1);
    const numeral = document.querySelector<HTMLElement>('.p .filing-mark');
    expect(numeral).not.toBeNull();
    // The door wraps the sentence's text only: no control stands inside a button.
    expect(document.querySelector('.sentence-door button')).toBeNull();
    numeral?.focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => {
      numeral?.dispatchEvent(event);
    });
    // The sentence's handler bails: the numeral's own keys are never swallowed.
    expect(event.defaultPrevented).toBe(false);
    expect(rec()?.getAttribute('data-acc')).toBe('open');
    // And the numeral's own act still reaches the filing — in the record at that sentence.
    await press('.p .filing-mark');
    expect(document.querySelector('.filing-panel')).toBeNull();
    expect(rec()?.getAttribute('data-body')).toBe('filing');
  });

  it('walks the paragraph by keyboard: one tab stop, arrows to every sentence, Enter opens', async () => {
    await mount();
    const sentences = [...document.querySelectorAll<HTMLElement>('.p .sentence-door')];
    expect(sentences[0]?.getAttribute('tabindex')).toBe('0');
    expect(sentences[1]?.getAttribute('tabindex')).toBe('-1');
    expect(sentences.filter((node) => node.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(sentences[0]?.getAttribute('role')).toBe('button'); // text-only door
    sentences[0]?.focus();
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(sentences[1]);
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    await frames();
    expect(rec()).not.toBeNull();
    expect(document.querySelector('.rec-quote')?.textContent).toContain(
      document.querySelectorAll<HTMLElement>('.p [data-s]')[1]?.getAttribute('data-quote') ?? 'x',
    );
    // The second sentence is now the marked one.
    expect(sentences[1]?.getAttribute('data-touch')).not.toBeNull();
  });

  it('swaps by keyboard: Enter on a neighbour shows it, it does not close the record', async () => {
    await mount();
    const doors = [...document.querySelectorAll<HTMLElement>('.p .sentence-door')];
    doors[0]?.focus();
    const press = async (key: string): Promise<void> => {
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      });
      await frames();
    };
    await press('Enter');
    expect(rec()).not.toBeNull();
    expect(document.querySelector('.rec-quote')?.textContent).toContain(doors[0]?.textContent ?? 'x');
    await press('ArrowRight');
    expect(document.activeElement).toBe(doors[1]);
    await press('Enter');
    // The neighbour is shown — a swap, not a close.
    expect(rec()).not.toBeNull();
    expect(rec()?.getAttribute('data-acc')).toBe('open');
    expect(document.querySelector('.rec-quote')?.textContent).toContain(doors[1]?.textContent ?? 'x');
    expect(doors[0]?.getAttribute('data-touch')).toBeNull();
    expect(doors[1]?.getAttribute('data-touch')).not.toBeNull();
    // A second Enter on the same sentence closes it.
    await press('Enter');
    expect(rec()).toBeNull();
  });

  it('reads a filing in full in the same body, and goes back', async () => {
    await mount([comment()]);
    await tapSentence(1);
    await press('.rec-row');
    expect(rec()?.getAttribute('data-body')).toBe('filing');
    expect(document.querySelector('.rec-filing-text')?.textContent).toContain('в комнате должен быть свет');
    expect(document.querySelectorAll('.rec-close')).toHaveLength(1);
    await press('.rec-back');
    expect(rec()?.getAttribute('data-body')).toBe('list');
  });
});
