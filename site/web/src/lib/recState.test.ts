import type { CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { countOf, headLineOf, historyRows, interventionRows, recordStateOf, rowWindow, type RecordSituation } from './recState.ts';
import { filingMarginalia } from './marginalia.ts';

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
    expect(result.line).toBe('ваша — ждёт');
  });

  it('внесено — the text includes the accepted change, and the line says where it went', () => {
    const result = state({ filings: [filing({ status: 'applied', applied: { chapter: 67, rev: 4 } })] });
    expect(result.word).toBe('внесено');
    // BOOK-218 — the landing's one sentence, from `marginalia.ts` (`landedSentence`).
    expect(result.line).toBe('в главу 67. это четвёртая редакция');
    expect(result.ink).toBe('ink');
  });

  it('отклонено — the gate’s word and the reason, whole', () => {
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

  it('the deck’s `идёт` — accepted, and only while the writer is at it', () => {
    // BOOK-189: the row's word stops at triage; the linked change says whether the writer holds
    // it now. `pending` waits, `processing` is «идёт» with the one line «пишется».
    const working = state({ filings: [filing({ status: 'accepted', changeStatus: 'processing' })] });
    expect(working.word).toBe('главу пишут');
  });

  it('ждёт — an accepted filing the lane has not reached yet', () => {
    const pending = state({ filings: [filing({ status: 'accepted', changeStatus: 'pending' })] });
    expect(pending.word).toBe('принято');
    // A row written before BOOK-189 carries no field: it is not a queue place either.
    const legacy = state({ filings: [filing({ status: 'accepted' })] });
    expect(legacy.word).toBe('принято');
    // The reader's own filing says whose it is, in the same word.
    const own = state({ filings: [filing({ status: 'accepted', author: 'Филипп' })], own: (c) => c.author === 'Филипп' });
    expect(own.word).toBe('принято');
  });

  it('prints the same three words as the thread: внесено · ждёт · отклонено', () => {
    // BOOK-189 — one fixture, three filings, three words, and the receipt under the landing.
    const rows = [
      filing({ id: 'cmt_a', status: 'applied', applied: { chapter: 67, rev: 4 } }),
      filing({ id: 'cmt_p', status: 'accepted', changeStatus: 'pending' }),
      filing({ id: 'cmt_r', status: 'rejected', refusal: 'auditor', reason: 'вне книги: этот мир не просит чудес' }),
    ];
    const words = rows.map((row) => state({ filings: [row] }));
    expect(words[0]).toMatchObject({ word: 'внесено', line: 'в главу 67. это четвёртая редакция', situation: 'landed' });
    expect(words[1]).toMatchObject({ word: 'принято', situation: 'waiting' });
    expect(words[2]).toMatchObject({ word: 'не принято', line: 'вне книги: этот мир не просит чудес', situation: 'refused' });
    expect(JSON.stringify(words[0])).not.toContain('идёт');
  });

  it('the deck’s hold — a quarantined filing waits for a person', () => {
    const result = state({ filings: [filing({ status: 'quarantined' })] });
    expect(result.word).toBe('проверяется');
    expect(result.line).toBe('ждёт человека');
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
    expect(interventionRows({ filings: [held], own: never })[0]?.facts).toContain('проверяется');
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

describe('the head line (§11.3)', () => {
  const version = {
    blockUid: 'u1',
    ver: 1,
    blockId: 'ch67#b1',
    chapter: 67,
    rev: 4,
    at: '2026-10-28T12:08:00Z',
    op: 'revised' as const,
    textHash: 'h',
    chars: 10,
    changeId: 'chg_1',
    changeSeq: 12,
    stepId: null,
    actor: { kind: 'writer' as const, label: 'печатник', identityId: 'id1' },
    replacedBy: null,
  };
  const chain = { blockUid: 'u1', blockId: 'ch67#b1', chapter: 67, alive: true, versions: [version], line: 'печатник' };

  it('prints the reader’s act, never the printer’s timestamp', () => {
    const own = headLineOf({ filing: filing({ author: 'Филипп' }), viewer: 'Филипп', chain, frozen: null });
    expect(own).toBe('вы предложили 28.10, 15:08');
    const other = headLineOf({ filing: filing(), viewer: 'Филипп', chain, frozen: null });
    expect(other).toBe('читатель предложил 28.10, 15:08');
    expect(own).not.toContain('2026');
    expect(own).not.toContain('печатник');
  });

  it('names the printer’s act only where no filing is the subject', () => {
    expect(headLineOf({ filing: null, viewer: null, chain, frozen: null })).toBe('машина внесла правку 28.10, 15:08');
    expect(headLineOf({ filing: null, viewer: null, chain: null, frozen: null })).toBeNull();
    expect(headLineOf({ filing: null, viewer: null, chain: null, frozen: 'frame' })).toBe('рамка книги');
  });
});

describe('rows', () => {
  it('prints the change’s own number, never a token cut from an id', () => {
    const [row] = interventionRows({
      filings: [filing({ id: 'cmt_A7K', author: 'Филипп', changeSeq: 7 })],
      own: () => true,
    });
    expect(row?.facts).toContain('правка 007');
    expect(row?.facts).not.toContain('№A7K');
    expect(row?.facts).toContain('ваше');
    expect(row?.own).toBe(true);
  });

  it('leaves the record’s own filing out of `замечания`', () => {
    const subject = filing({ id: 'cmt_A7K' });
    const other = filing({ id: 'cmt_B2M', changeSeq: 8 });
    const rows = interventionRows({ filings: [subject, other], own: () => false, subject: 'cmt_A7K' });
    expect(rows.map((row) => row.id)).toEqual(['cmt_B2M']);
    const self = interventionRows({ filings: [subject], own: () => false, subject: 'cmt_A7K' });
    expect(self).toEqual([]);
  });

  const VERSION = {
    blockUid: 'u1',
    ver: 1,
    blockId: 'ch67#b1',
    chapter: 67,
    rev: 4,
    at: '2026-10-28T12:08:00Z',
    op: 'revised' as const,
    textHash: 'h',
    chars: 10,
    changeId: 'chg_1',
    changeSeq: 12,
    stepId: null,
    actor: { kind: 'writer' as const, label: 'печатник', identityId: 'id1' },
    replacedBy: null,
  };

  it('answers when, who and what for every row — never a placeholder', () => {
    const [row] = historyRows({
      chain: { blockUid: 'u1', blockId: 'ch67#b1', chapter: 67, alive: true, versions: [VERSION], line: 'печатник' },
    });
    expect(row?.facts).toBe('28.10, 15:08 · машина внесла правку');
    expect(row?.specimen).toBe('');
    expect(row?.facts).not.toContain('пара');
  });

  it('names the reader’s proposal and keeps the pair when the book holds it', () => {
    const subject = filing({
      changeId: 'chg_1',
      changeSeq: 12,
      createdAt: '2026-10-28T00:24:00Z',
      status: 'applied',
      anchor: { ...filing().anchor, quote: 'Её освещал тусклый свет.' },
    });
    const rows = historyRows({
      chain: { blockUid: 'u1', blockId: 'ch67#b1', chapter: 67, alive: true, versions: [VERSION], line: 'печатник' },
      filing: subject,
      viewer: 'Аня',
      quote: 'Её освещал яркий свет.',
    });
    expect(rows.map((row) => row.facts)).toEqual([
      '28.10, 15:08 · машина внесла правку',
      '28.10, 03:24 · вы предложили эту правку',
    ]);
    expect(rows[0]?.specimen).toBe('было: «Её освещал тусклый свет.» → стало: «Её освещал яркий свет.»');
  });

  it('dedupes two rows with the same minute, kind and change', () => {
    const rows = historyRows({
      chain: {
        blockUid: 'u1',
        blockId: 'ch67#b1',
        chapter: 67,
        alive: true,
        versions: [VERSION, { ...VERSION, ver: 2, at: '2026-10-28T12:08:40Z' }],
        line: 'печатник',
      },
    });
    expect(rows).toHaveLength(1);
  });

});

describe('the situation type', () => {
  it('names the eight situations the block prints', () => {
    const all: RecordSituation[] = ['writing', 'waiting', 'waitingOwn', 'working', 'held', 'landed', 'refused', 'untouched'];
    expect(all).toHaveLength(8);
  });
});
