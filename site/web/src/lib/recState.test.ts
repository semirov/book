import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { countOf, historyRows, interventionRows, recordStateOf, rowWindow, type RecordSituation } from './recState.ts';

/**
 * BOOK-128 comment #3862 §2 — the six situations, in words the book already prints.
 *
 * Each case is one row of the copy table, and the line under the word is asserted with it: the
 * word alone never carries the fact. The two situations the deck forces (`идёт`, a hold) are
 * here for the same reason: without them the block would jump from «ждёт» to «внесено».
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

const never = () => false;
const base = { chain: null, writing: false, frozen: null };

function state(overrides: Partial<Parameters<typeof recordStateOf>[0]>) {
  return recordStateOf({ filings: [], own: never, ...base, ...overrides });
}

describe('the six situations', () => {
  it('пишется — a pass is at this paragraph, and the word is the whole answer', () => {
    const result = state({ writing: true });
    expect(result.word).toBe('пишется');
    expect(result.ink).toBe('live');
    expect(result.line).toBeNull();
  });

  it('ждёт — a filing waits, and the line says what the word cannot', () => {
    const result = state({ filings: [filing()] });
    expect(result.word).toBe('ждёт');
    expect(result.line).toBe('решения ещё нет');
  });

  it('ждёт — the reader’s own filing: possession is a fact on the line, never a word', () => {
    const own = filing({ author: 'Филипп' });
    const result = state({ filings: [own], own: (comment) => comment.author === 'Филипп' });
    expect(result.word).toBe('ждёт');
    expect(result.line).toBe('ваша — в очереди');
  });

  it('внесено — the text includes the accepted change, and the line says where it went', () => {
    const result = state({ filings: [filing({ status: 'applied', applied: { chapter: 67, rev: 4 } })] });
    expect(result.word).toBe('внесено');
    // BOOK-189 — the one receipt shape of every surface: «глава 67 · ревизия 4».
    expect(result.line).toBe('глава 67 · ревизия 4');
    expect(result.ink).toBe('ink');
  });

  it('отклонено — the gate’s word and the reason, whole', () => {
    const result = state({
      filings: [filing({ status: 'rejected', refusal: 'auditor', reason: 'чужая цитата без источника' })],
    });
    expect(result.word).toBe('отклонено');
    expect(result.line).toBe(': чужая цитата без источника');
    expect(result.ink).toBe('revise');
  });

  it('untouched — one sentence, no word, no headers', () => {
    const result = state({});
    expect(result.word).toBeNull();
    expect(result.line).toBe('с тех пор её никто не трогал');
    expect(result.empty).toBe(true);
  });

  it('the deck’s `идёт` — accepted, and only while the writer is at it', () => {
    // BOOK-189: the row's word stops at triage; the linked change says whether the writer holds
    // it now. `pending` waits, `processing` is «идёт» with the one line «пишется».
    const working = state({ filings: [filing({ status: 'accepted', changeStatus: 'processing' })] });
    expect(working.word).toBe('идёт');
    expect(working.line).toBe('пишется');
  });

  it('ждёт — an accepted filing the lane has not reached yet', () => {
    const pending = state({ filings: [filing({ status: 'accepted', changeStatus: 'pending' })] });
    expect(pending.word).toBe('ждёт');
    expect(pending.line).toBe('в очереди на запись');
    // A row written before BOOK-189 carries no field: it is not a queue place either.
    const legacy = state({ filings: [filing({ status: 'accepted' })] });
    expect(legacy.word).toBe('ждёт');
    expect(legacy.line).toBe('в очереди на запись');
    // The reader's own filing says whose it is, in the same word.
    const own = state({ filings: [filing({ status: 'accepted', author: 'Филипп' })], own: (c) => c.author === 'Филипп' });
    expect(own.word).toBe('ждёт');
    expect(own.line).toBe('ваша — в очереди');
  });

  it('prints the same three words as the thread: внесено · ждёт · отклонено', () => {
    // BOOK-189 — one fixture, three filings, three words, and the receipt under the landing.
    const rows = [
      filing({ id: 'cmt_a', status: 'applied', applied: { chapter: 67, rev: 4 } }),
      filing({ id: 'cmt_p', status: 'accepted', changeStatus: 'pending' }),
      filing({ id: 'cmt_r', status: 'rejected', refusal: 'auditor', reason: 'вне книги: этот мир не просит чудес' }),
    ];
    const words = rows.map((row) => state({ filings: [row] }));
    expect(words[0]).toMatchObject({ word: 'внесено', line: 'глава 67 · ревизия 4', situation: 'landed' });
    expect(words[1]).toMatchObject({ word: 'ждёт', line: 'в очереди на запись', situation: 'waiting' });
    expect(words[2]).toMatchObject({ word: 'отклонено', line: ': вне книги: этот мир не просит чудес', situation: 'refused' });
    expect(JSON.stringify(words[0])).not.toContain('идёт');
  });

  it('the deck’s hold — a quarantined filing waits for a person', () => {
    const result = state({ filings: [filing({ status: 'quarantined' })] });
    expect(result.word).toBe('ждёт');
    expect(result.line).toBe('ждёт человека');
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
            actor: { kind: 'writer', label: 'печатник', identityId: 'id1' },
            replacedBy: null,
          },
        ],
        line: 'печатник',
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

describe('rows', () => {
  it('marks the reader’s own filing and prints its numeral first', () => {
    const [row] = interventionRows({ filings: [filing({ id: 'cmt_A7K', author: 'Филипп' })], own: () => true });
    expect(row?.facts).toContain('№A7K');
    expect(row?.facts).toContain('ваше');
    expect(row?.own).toBe(true);
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
          actor: { kind: 'writer', label: 'печатник', identityId: 'id1' },
          replacedBy: null,
        },
      ],
      line: 'печатник',
    });
    expect(row?.facts).toContain('печатник');
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
