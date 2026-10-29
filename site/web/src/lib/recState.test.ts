import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { formatDate, formatTime } from './format.ts';
import { OWN_WAITING_LINE, STATE_LINES, STATE_WORDS } from './marginalia.ts';
import {
  RECORD_HEAD_EMPTY,
  countOf,
  historyRows,
  interventionRows,
  recordHeadOf,
  recordStateOf,
  rowWindow,
  type RecordSituation,
} from './recState.ts';
import { filingMarginalia } from './marginalia.ts';

/**
 * BOOK-128 comment #3862 §2 — the six situations, in words the book already prints.
 *
 * Each case is one row of the copy table, and the line under the word is asserted with it: the
 * word alone never carries the fact. BOOK-218: every word and line is asserted through the
 * module's constants, so a copy change is one edit and no test re-types the sentence.
 */

function filing(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 67,
    anchor: { blockId: 'ch67#b1', blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
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
    createdAt: '2026-10-28T12:08:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  } as CommentDto;
}

/** `28.10, 15:08` — the row register's short moment, as the sheet prints it in the test's zone. */
function momentOf(iso: string): string {
  return `${formatDate(iso).slice(0, 5)}, ${formatTime(iso)}`;
}

const never = () => false;
const base = { chain: null, writing: false, frozen: null };

function state(overrides: Partial<Parameters<typeof recordStateOf>[0]>) {
  return recordStateOf({ filings: [], own: never, ...base, ...overrides });
}

describe('the six situations', () => {
  it('главу пишут — a pass is at this paragraph, and the word is the whole answer', () => {
    const result = state({ writing: true });
    expect(result.word).toBe('главу пишут');
    expect(result.ink).toBe('live');
    expect(result.line).toBeNull();
  });

  it('ждёт — a filing waits, and the line says what the word cannot', () => {
    const result = state({ filings: [filing()] });
    expect(result.word).toBe(STATE_WORDS.waiting);
    expect(result.line).toBe(STATE_LINES.waiting);
  });

  it('ждёт — the reader’s own filing: possession is a fact on the line, never a word', () => {
    const own = filing({ author: 'Филипп' });
    const result = state({ filings: [own], own: (comment) => comment.author === 'Филипп' });
    expect(result.word).toBe(STATE_WORDS.waiting);
    expect(result.line).toBe(OWN_WAITING_LINE);
  });

  it('внесено — the text includes the accepted change, and the line says where it went', () => {
    const result = state({ filings: [filing({ status: 'applied', applied: { chapter: 67, rev: 4 } })] });
    expect(result.word).toBe('внесено');
    // BOOK-218 line 10 — the one receipt shape of every surface: `в главу 67. это четвёртая
    // редакция`, the sink word standing above it.
    expect(result.line).toBe('в главу 67. это четвёртая редакция');
    expect(result.ink).toBe('ink');
  });

  it('не принято — the sink word and the reason, whole', () => {
    const result = state({
      filings: [filing({ status: 'rejected', refusal: 'auditor', reason: 'чужая цитата без источника' })],
    });
    expect(result.word).toBe('не принято');
    expect(result.line).toBe('чужая цитата без источника');
    expect(result.ink).toBe('revise');
  });

  it('untouched — one sentence, no word, no headers', () => {
    const result = state({});
    expect(result.word).toBeNull();
    expect(result.line).toBe('с тех пор её никто не трогал');
    expect(result.empty).toBe(true);
  });

  it('главу пишут — accepted, and only while the writer is at this chapter', () => {
    // BOOK-189, BOOK-218 line 7: while the linked change is `processing` the row's word itself is
    // the sentence `главу пишут`, and no second line repeats it.
    const working = state({ filings: [filing({ status: 'accepted', changeStatus: 'processing' })] });
    expect(working.word).toBe(STATE_WORDS.writing);
    expect(working.line).toBeNull();
  });

  it('принято — an accepted filing whose chapter turn has not come yet', () => {
    const pending = state({ filings: [filing({ status: 'accepted', changeStatus: 'pending' })] });
    expect(pending.word).toBe(STATE_WORDS.accepted);
    expect(pending.line).toBe(STATE_LINES.accepted);
    // A row written before BOOK-189 carries no field: it says the same, and promises nothing.
    const legacy = state({ filings: [filing({ status: 'accepted' })] });
    expect(legacy.word).toBe(STATE_WORDS.accepted);
    expect(legacy.line).toBe(STATE_LINES.accepted);
    // The reader's own filing is not «пишется» until the machine is there.
    const own = state({ filings: [filing({ status: 'accepted', author: 'Филипп' })], own: (c) => c.author === 'Филипп' });
    expect(own.word).toBe(STATE_WORDS.accepted);
    expect(own.line).toBe(STATE_LINES.accepted);
    expect(pending.word).not.toBe(STATE_WORDS.writing);
    expect(pending.line).not.toBe(STATE_WORDS.writing);
  });

  it('prints the same three words as the thread: внесено · принято · не принято', () => {
    // BOOK-189 — one fixture, three filings, three words, and the receipt under the landing.
    const rows = [
      filing({ id: 'cmt_a', status: 'applied', applied: { chapter: 67, rev: 4 } }),
      filing({ id: 'cmt_p', status: 'accepted', changeStatus: 'pending' }),
      filing({ id: 'cmt_r', status: 'rejected', refusal: 'auditor', reason: 'вне книги: этот мир не просит чудес' }),
    ];
    const words = rows.map((row) => state({ filings: [row] }));
    expect(words[0]).toMatchObject({ word: 'внесено', line: 'в главу 67. это четвёртая редакция', situation: 'landed' });
    expect(words[1]).toMatchObject({ word: STATE_WORDS.accepted, line: STATE_LINES.accepted, situation: 'waiting' });
    expect(words[2]).toMatchObject({ word: 'не принято', line: 'вне книги: этот мир не просит чудес', situation: 'refused' });
    expect(JSON.stringify(words[0])).not.toContain('идёт');
  });

  it('the deck’s hold — a quarantined filing waits for a person', () => {
    const result = state({ filings: [filing({ status: 'quarantined' })] });
    expect(result.word).toBe(STATE_WORDS.held);
    expect(result.line).toBe(STATE_LINES.held);
  });

  it('takes every word from the deck, never a second copy of the rule', () => {
    // BOOK-90 — the record's word is `filingMarginalia`'s, for every status the DTO can carry:
    // a superseded or held row waits («ждёт»), a paperwork row is «рассмотрено», and only the
    // server's own `applied`/`rejected`/live rows say the rest.
    const statuses = [
      'new',
      'batched',
      'delivered',
      'accepted',
      'applied',
      'registered',
      'superseded',
      'rejected',
      'quarantined',
      'expired',
      'hidden',
    ] as const;
    for (const status of statuses) {
      const row = filing({ status });
      expect(recordStateOf({ filings: [row], own: never, ...base }).word, status).toBe(filingMarginalia(row).word);
    }
  });

  it('prints the server’s stopped filing as a decision, with its own sentence (BOOK-206 B2)', () => {
    const result = state({
      filings: [filing({ status: 'rejected', reason: 'правка остановлена — текст остался прежним' })],
    });
    expect(result.word).toBe('не принято');
    expect(result.line).toBe('правка остановлена — текст остался прежним');
    expect(result.line).not.toContain('в очереди');
  });

  it('prints a paperwork row as «рассмотрено», never as a refusal (BOOK-137)', () => {
    const result = state({
      filings: [filing({ status: 'registered', reason: 'принято как оформление: рамка книги — фраза не меняется' })],
    });
    expect(result.word).toBe('рассмотрено');
    expect(result.line).toBe('оформление · фраза не изменилась');
  });

  it('the row register prints the same word as the state block', () => {
    const held = filing({ id: 'cmt_hold', status: 'quarantined' });
    expect(interventionRows({ filings: [held], own: never })[0]?.facts).toContain(STATE_WORDS.held);
    const refused = filing({ id: 'cmt_ref', status: 'rejected', refusal: 'rights', reason: 'не принято: пересказ' });
    expect(interventionRows({ filings: [refused], own: never })[0]?.facts).toContain('не принято');
  });

  it('a landed version the chain numbers prints the change in the head cell, and no line', () => {
    const result = state({
      chain: {
        blockUid: 'u1',
        blockId: 'ch67#b1',
        chapter: 67,
        alive: true,
        versions: [
          {
            blockUid: 'u1',
            ver: 1,
            blockId: 'ch67#b1',
            chapter: 67,
            rev: 4,
            at: '2026-10-28T12:08:00Z',
            op: 'revised',
            textHash: 'h',
            chars: 10,
            changeId: 'chg_1',
            changeSeq: 12,
            stepId: null,
            actor: { kind: 'writer', label: 'машина', identityId: 'id1' },
            replacedBy: null,
          },
        ],
        line: 'машина',
      },
    });
    expect(result.word).toBe('внесено · правка 012');
    expect(result.line).toBeNull();
  });

  it('the frozen frame has no state word beyond `не меняется`', () => {
    const result = state({ frozen: 'frame' });
    expect(result.word).toBe('не меняется');
    expect(result.ink).toBe('quiet');
  });
});

describe('the count law', () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ id: String(index) }));

  it('prints three, and the door names the rest', () => {
    const windowed = rowWindow(rows.slice(0, 5), false);
    expect(windowed.rows).toHaveLength(3);
    expect(windowed.rest).toBe(2);
    // The lifted state reveals every row, so the door's promise is exactly what it shows.
    const lifted = rowWindow(rows.slice(0, 5), true);
    expect(lifted.rows).toHaveLength(5);
    expect(lifted.rest).toBe(0);
  });

  it('a long list folds to three and opens whole — never a count without a door', () => {
    const windowed = rowWindow(rows, false);
    expect(windowed.rows).toHaveLength(3);
    expect(windowed.rest).toBe(4);
    expect(rowWindow(rows, true).rows).toHaveLength(7);
    expect(rowWindow(rows, true).rest).toBe(0);
  });

  it('holds the law for every list length 1..12 and both steps', () => {
    for (let size = 1; size <= 12; size += 1) {
      const list = Array.from({ length: size }, (_, index) => ({ id: String(index) }));
      for (const lifted of [false, true]) {
        const windowed = rowWindow(list, lifted);
        // The window is a window: shown + hidden is the whole list, and a hidden row is always
        // counted by the door that reveals it.
        expect(windowed.rows.length + windowed.rest, `${size}/${String(lifted)}`).toBe(size);
        expect(windowed.rest === 0).toBe(lifted || size <= 3);
        if (!lifted) expect(windowed.rows).toHaveLength(Math.min(3, size));
      }
    }
  });

  it('never counts a zero or a one', () => {
    expect(countOf([])).toBeNull();
    expect(countOf([1])).toBeNull();
    expect(countOf([1, 2])).toBe('2');
  });
});

describe('the head is the reader’s (BOOK-218)', () => {
  it('names what this is and when the reader’s own action happened', () => {
    const own = filing({ id: 'cmt_1', number: 12, author: 'Филипп', createdAt: '2026-10-29T12:07:00Z' });
    const head = recordHeadOf({ filings: [own], own: (comment) => comment.author === 'Филипп' });
    expect(head.filing?.id).toBe('cmt_1');
    expect(head.line).toBe(`замечание 12 · вы предложили · ${momentOf('2026-10-29T12:07:00Z')}`);
  });

  it('drops «ваша» for another reader’s filing, and says what this is when there is none', () => {
    const other = filing({ id: 'cmt_2', number: 9, createdAt: '2026-10-27T09:00:00Z' });
    const head = recordHeadOf({ filings: [other], own: () => false });
    expect(head.line).toBe(`замечание 9 · ${momentOf('2026-10-27T09:00:00Z')}`);
    expect(head.line).not.toContain('ваша');
    expect(recordHeadOf({ filings: [], own: () => false })).toEqual({ filing: null, line: RECORD_HEAD_EMPTY });
    expect(RECORD_HEAD_EMPTY).toBe('запись о фразе');
  });

  it('carries no hand and no process moment', () => {
    // `машина · 28.10.2026, 00:24` belongs to `история`: the head is the reader's.
    const head = recordHeadOf({ filings: [filing({ number: 12 })], own: () => true });
    expect(head.line).not.toContain('машина');
    expect(head.line).not.toContain('2026');
  });
});

describe('rows', () => {
  it('reads as the filing’s own number, its moment and whose it is', () => {
    // BOOK-218 — `правка 12 · 29.10, 12:07 · ваше`: no `№`, no code, no «замечание» prefix.
    const [row] = interventionRows({
      filings: [filing({ id: 'cmt_A7K', number: 12, author: 'Филипп', createdAt: '2026-10-29T12:07:00Z' })],
      own: () => true,
      headId: null,
    });
    // The moment is the reader's own clock (the page formats it, not this module).
    expect(row?.facts).toBe(`замечание 12 · ${momentOf('2026-10-29T12:07:00Z')} · ваше · ${STATE_WORDS.waiting}`);
    expect(row?.own).toBe(true);
  });

  it('prints the state once: a filing the head already states carries no word and no line', () => {
    const own = filing({ id: 'cmt_1', number: 12, author: 'Филипп' });
    const other = filing({ id: 'cmt_2', number: 9, createdAt: '2026-10-27T09:00:00Z' });
    const [first, second] = interventionRows({ filings: [own, other], own: () => true, headId: 'cmt_1' });
    // The head states `правка 12` and its one line; its row is the pointer, not a second telling.
    expect(first?.facts).toBe(`замечание 12 · ${momentOf('2026-10-28T12:08:00Z')} · ваше`);
    expect(first?.specimen).toBe('');
    // Another filing keeps its own word and line: nothing else states it.
    expect(second?.facts).toContain(STATE_WORDS.waiting);
    expect(second?.specimen).toBe(STATE_LINES.waiting);
  });

  it('history rows carry the hand, the change and the honest absence of a pair', () => {
    const [row] = historyRows({
      blockUid: 'u1',
      blockId: 'ch67#b1',
      chapter: 67,
      alive: true,
      versions: [
        {
          blockUid: 'u1',
          ver: 1,
          blockId: 'ch67#b1',
          chapter: 67,
          rev: 4,
          at: '2026-10-28T12:08:00Z',
          op: 'revised',
          textHash: 'h',
          chars: 10,
          changeId: 'chg_1',
          changeSeq: 12,
          stepId: null,
          actor: { kind: 'writer', label: 'машина', identityId: 'id1' },
          replacedBy: null,
        },
      ],
      line: 'машина',
    });
    expect(row?.facts).toContain('машина');
    expect(row?.facts).toContain('правка 012');
    expect(row?.specimen).toBe('пара не записана');
  });
});

describe('the situation type', () => {
  it('names the eight situations the block prints', () => {
    const all: RecordSituation[] = ['writing', 'waiting', 'waitingOwn', 'working', 'held', 'landed', 'refused', 'untouched'];
    expect(all).toHaveLength(8);
  });
});
