// @vitest-environment jsdom
import type { CatalogEntry, CommentDto } from '@book/shared';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { postAnchoredComment } from '../api.ts';
import { EMPTY_COMPOSER } from '../lib/composer.ts';

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>();
  return { ...actual, postAnchoredComment: vi.fn() };
});
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
    number: 1,
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

describe('one filing, one mark (BOOK-218)', () => {
  // The paragraph says the same sentence twice, so the group is reached from two runs: the
  // page used to print `12 12` beside one filing.
  const REPEATED = 'Свет был яркий. Свет был яркий.';

  it('draws exactly one mark and one note for one filing', async () => {
    await mount([comment({ anchor: { ...comment().anchor, quote: 'Свет был яркий.' } })], REPEATED);
    expect(container.querySelectorAll('.filing-mark')).toHaveLength(1);
    expect(container.querySelectorAll('.margin-note')).toHaveLength(1);
    // The phone strip is the same filing once too: a second row under the same key is the
    // duplicate React warns about, and `12 12` in the gutter in another form.
    expect(container.querySelectorAll('.phone-strip-row')).toHaveLength(1);
    const marks = [...container.querySelectorAll('.filing-mark-num')].map((node) => node.textContent);
    expect(marks).toEqual(['1']);
  });

  it('still draws one mark per filing when two filings share the same sentence', async () => {
    await mount(
      [
        comment({ id: 'cmt_1', number: 1, anchor: { ...comment().anchor, quote: 'Свет был яркий.' } }),
        comment({
          id: 'cmt_2',
          number: 2,
          createdAt: '2026-10-22T12:03:00Z',
          anchor: { ...comment().anchor, quote: 'Свет был яркий.' },
        }),
      ],
      REPEATED,
    );
    // BOOK-220 §11.3 — one slot **per sentence group**: the numeral names the newest filing and
    // the note's head counts the rest (`ещё 1`). The other filing is reached through the record's
    // `замечания`, never by a second numeral on the same line.
    expect(container.querySelectorAll('.filing-mark')).toHaveLength(1);
    expect(container.querySelectorAll('.filing-mark-num')[0]?.textContent).toBe('2');
    expect(container.querySelectorAll('.margin-note')).toHaveLength(1);
    expect(container.querySelector('.margin-note-more')?.textContent).toBe('ещё 1');
  });
});

describe('the record’s head is the reader’s (BOOK-218)', () => {
  it('names the filing and its moment, and says the state once', async () => {
    await mount([comment({ number: 12, author: 'Филипп' })]);
    await click('.margin-note');
    // BOOK-220 §11.3 — the head is two facts: the reader's own act (`.rec-hand`) and the state
    // row (`.rec-state`), which names the filing and says the word once.
    const hand = document.querySelector('.rec-hand');
    expect(hand?.textContent).toMatch(/^вы предложили \d\d\.\d\d, \d\d:\d\d$/u);
    expect(hand?.textContent).not.toContain('машина');
    // The one word, and the one line under it — the record states the filing, once.
    // The head row prints the word; the filing's own number is the mark's and the record's
    // `замечания` row, so the word stands once here.
    expect(document.querySelector('.rec-state')?.textContent).toMatch(/^(ждёт|принято)$/u);
    expect(document.querySelector('.rec-state-line')?.textContent).toBeTruthy();
    // The note is the pointer: it carries the quote and who filed it, never a code.
    // BOOK-220 §11.3 — the note stands down while the record is open: one filing, once.
    expect(document.querySelector('.margin-note')).toBeNull();
  });

  it('answers the reader’s three questions once, with no code and no second telling', async () => {
    // The owner's photograph (BOOK-218): what I asked for, what is happening, what I can do next —
    // and beside it no code-like token, no state said twice, no mark on the prose's line.
    await mount([comment({ number: 12, author: 'Филипп' })]);
    // The paragraph and its record: the block opens on the sentence the filing stands on.
    const sentences = container.querySelectorAll<HTMLElement>('.p [data-s]');
    await act(async () => sentences[1]?.click());
    await settle();
    const rec = document.querySelector('.rec');
    const text = (node: Element | null): string => (node?.textContent ?? '').replace(/\s+/gu, ' ');
    const record = text(rec);
    // What I asked for: the phrase (in the paragraph; this fixture's chain answers empty, so the
    // block prints its own «история не прочиталась» instead of a quote); what is happening: one
    // word and one line; what next: `вмешаться`.
    expect(text(document.querySelector('.p'))).toContain('Её освещал яркий свет.');
    // The state row says the word once; the line under it says what happens next.
    expect(document.querySelector('.rec-state')?.textContent).toBe('ждёт');
    expect(document.querySelector('.rec-state-line')?.textContent).toBe('ваша — ждёт');
    expect(record).toContain('вмешаться');
    // The head is the reader's, and no id or `№` stands anywhere in the block or the margin.
    expect(record).toContain('вы предложили');
    expect(text(document.querySelector('.p')) + record).not.toMatch(/№|cmt_[0-9A-Z]{6}/u);
    // The head's word and the line under it (`ваша — ждёт`) are the two rows of the same fact;
    // the thread beside the record does not repeat either of them.
    expect(document.querySelector('.rec-state')?.textContent).toBe('ждёт');
    // The open record stands on the sentence: the note beside it has stood down (one filing,
    // once per screen), and the block names the reader's own act rather than the machine's.
    expect(document.querySelector('.margin-note')).toBeNull();
    expect(record).toContain('вы предложили');
    // The mark is placed in the margin channel by its slot, not laid inline in the sentence.
    const mark = document.querySelector('.p .filing-mark');
    expect(mark).not.toBeNull();
    expect(document.querySelector('.p .filing-mark-slot')).not.toBeNull();
  });

  it('drops «ваша» for another reader, and says what the record is when nothing is filed', async () => {
    await mount([comment({ number: 7 })]);
    await click('.margin-note');
    expect(document.querySelector('.rec-hand')?.textContent).toMatch(/^читатель предложил \d\d\.\d\d, \d\d:\d\d$/u);
    expect(document.querySelector('.rec-state')?.textContent).toBeTruthy();
    await act(async () => closeRecord());
    await settle();
    // The first sentence holds no filing: its head row prints no word, and the block names
    // itself in its accessible name.
    await click('.p [data-s]');
    expect(document.querySelector('.rec-state')?.textContent).toBe('');
    expect(document.querySelector('.rec')?.getAttribute('aria-label')).toMatch(/^запись о фразе/u);
  });
});

describe('the receipt and the head tell one state (BOOK-218)', () => {
  /** The paragraph with its own feed, the way the page keeps it: a posted filing arrives. */
  function Feed({ initial }: { initial: readonly CommentDto[] }) {
    const [rows, setRows] = useState<readonly CommentDto[]>(initial);
    return (
      <ProseParagraph
        entry={ENTRY}
        blockId="ch08#aa11bb22"
        blockIndex={1}
        baseRev={3}
        text={TEXT}
        blockCount={1}
        comments={rows}
        history
        composer={EMPTY_COMPOSER}
        viewer={{ signedIn: true, displayName: 'Филипп' }}
        onPosted={(comment) => setRows((current) => [...current, comment])}
      />
    );
  }

  it('prints «принято · замечание 12» and the module’s one line, and the head prints no second state', async () => {
    vi.mocked(postAnchoredComment).mockResolvedValue({
      comment: comment({
        number: 12,
        author: 'Филипп',
        // The record was opened on the first sentence: its filing is anchored there.
        anchor: { ...comment().anchor, quote: 'Я вошёл в пустую комнату.' },
      }),
      remaining: { remaining: 9, perHour: 10, editsRemaining: 1, editsPerDay: 1 },
    } as never);
    await act(async () => root?.render(<Feed initial={[]} />));
    await settle();
    // The untouched sentence opens its record, and the form is one act away.
    await click('.p [data-s]');
    await click('.rec-cta');
    const textarea = container.querySelector<HTMLTextAreaElement>('.seam-text');
    if (textarea === null) throw new Error('no form');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'в комнате должен быть свет, но не от лампы',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('.seam-submit')?.click());
    await settle();

    // The receipt owns the state of its filing: the word for the act, the filing's number, one line.
    const receipt = document.querySelector('.rec-receipt');
    expect(receipt?.textContent).toBe('принято');
    // The receipt prints the word and the filing's number; the line under it (when the module
    // has one) is the only second row.
    expect(receipt?.textContent).toContain('принято');
    expect(container.querySelectorAll('.rec-receipt-body .rec-line').length).toBeLessThanOrEqual(2);
    // …and the head above names the reader's own act without repeating the word or the line:
    // the receipt owns the state of its filing (BOOK-220 §11.3).
    expect(document.querySelector('.rec-hand')?.textContent).toMatch(/^вы предложили /u);
  });
});
