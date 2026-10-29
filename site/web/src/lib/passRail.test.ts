import type { PassStage, PassStageEvent, StageSpan } from '@book/shared';
import { describe, expect, it } from 'vitest';

import {
  RAIL_PRINTING,
  RAIL_WORDS,
  currentRow,
  eventsOfPass,
  factLines,
  latestPassId,
  livePassOf,
  liveRunOf,
  mergeStages,
  paragraphOf,
  passShortId,
  passStageAt,
  passStripModel,
  railRows,
  receiptOf,
  receiptTextOf,
} from './passRail.ts';

/**
 * The strip's pure model: five public words, one row per arrived stage, and no fact it was not
 * handed. Times are Moscow's (`formatTime`), so `08:18Z` reads `11:18`.
 */

const at = (iso: string): number => Date.parse(iso);
const T0 = at('2026-10-28T08:18:00Z');
const MIN = 60_000;

const span: StageSpan[] = [
  { blockId: 'ch07#bbbb2222', before: 'Второй абзац до подхода писателя.', after: 'Второй абзац, переписанный на ходу.', truncated: false },
];

function event(stage: PassStage, seq: number, overrides: Partial<PassStageEvent> = {}): PassStageEvent {
  return {
    passId: 'stp_01J9Z8K4Q7',
    chapter: 7,
    stageSeq: seq,
    stage,
    at: T0 + seq * MIN,
    actor: { process: 'writer', model: 'deepseek/deepseek-flash' },
    changeId: null,
    summary: `сводка ${String(seq)}`,
    span: null,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

const READING = [event('queued', 1, { at: T0 }), event('read', 2, { at: T0 + 4_000, summary: 'читает главу 7' })];

describe('the rail: one row per public state, from the events that exist', () => {
  it('reads the five words in stage order', () => {
    const events = [...READING, event('verdict', 3), event('drafting', 4), event('landed', 5, { span })];
    expect(railRows(events).map((row) => row.word)).toEqual([
      RAIL_WORDS.read,
      RAIL_WORDS.verdict,
      RAIL_WORDS.drafting,
      RAIL_WORDS.landed,
    ]);
    expect(railRows(events).map((row) => row.state)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('prints no row for a stage that never arrived', () => {
    expect(railRows([])).toEqual([]);
    // A pass that only read has one row: nothing below it is invented.
    expect(railRows(READING)).toHaveLength(1);
    expect(railRows([event('drafting', 4)]).map((row) => row.word)).toEqual([RAIL_WORDS.drafting]);
    // A stage a newer server invents is not a row: the rail prints what it was taught.
    expect(railRows([event('drafting', 4), event('invented' as PassStage, 5)])).toHaveLength(1);
  });

  it('folds queued and read into one «читает» row with the earliest moment', () => {
    const rows = railRows(READING);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.atMs).toBe(T0);
    // The read stage's own line speaks for the reading row.
    expect(rows[0]?.summary).toBe('читает главу 7');
    expect(rows[0]?.state).toBe('live');
  });

  it('turns the landed row into «печатается» when typing follows it — the same row', () => {
    const events = [...READING, event('drafting', 4), event('landed', 5, { span }), event('typing', 6)];
    const rows = railRows(events);
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)?.key).toBe('landed');
    expect(rows.at(-1)?.word).toBe(RAIL_PRINTING);
    expect(rows.at(-1)?.state).toBe('live');
  });

  it('ends the rail at a refusal, with nothing below it', () => {
    const events = [...READING, event('verdict', 3), event('refused', 4)];
    const rows = railRows(events);
    expect(rows.at(-1)?.key).toBe('refused');
    expect(rows.at(-1)?.word).toBe(RAIL_WORDS.refused);
    expect(rows.at(-1)?.state).toBe('refused');
    // A stage stamped after the refusal is not a row: the pass is over.
    expect(railRows([...events, event('landed', 5, { span })])).toHaveLength(3);
  });

  it('names the paragraph from the landed span when the page holds the block', () => {
    const landed = event('landed', 5, { span });
    const blocks = [{ id: 'ch07#aaaa1111' }, { id: 'ch07#bbbb2222' }];
    expect(railRows([...READING, landed], { blocks }).at(-1)?.paragraph).toBe(2);
    // Without the chapter, a hashed id names no position; a numeric one does.
    expect(railRows([...READING, landed]).at(-1)?.paragraph).toBeNull();
    expect(paragraphOf('ch07#12')).toBe(12);
  });

  it('gives a live row the paragraph it was opened on', () => {
    const blocks = [{ id: 'ch07#aaaa1111' }, { id: 'ch07#bbbb2222' }];
    const rows = railRows([event('drafting', 4)], { blocks, blockId: 'ch07#bbbb2222' });
    expect(rows[0]?.paragraph).toBe(2);
  });
});

describe('the reader’s clock: arrived rows, never a replay', () => {
  const events = [...READING, event('verdict', 3), event('drafting', 4)];

  it('answers the last row whose moment has come', () => {
    expect(currentRow(events, T0 + 1_000)?.key).toBe('read');
    expect(currentRow(events, T0 + 3 * MIN)?.key).toBe('verdict');
    expect(currentRow(events, T0 + 4 * MIN)?.key).toBe('drafting');
  });

  it('answers nothing before the first stored moment', () => {
    expect(currentRow(events, T0 - 1)).toBeNull();
  });

  it('keeps each row’s stored time for a late reader', () => {
    const rows = railRows(events);
    expect(rows.map((row) => row.atMs)).toEqual([T0, T0 + 3 * MIN, T0 + 4 * MIN]);
  });
});

describe('the handle and the receipt', () => {
  it('derives a stable display handle from the id', () => {
    expect(passShortId('stp_01J9Z8K4Q7')).toBe('№K4Q7');
    expect(passShortId('stp_a7k')).toBe('№A7K');
    expect(passShortId('!!!')).toBeNull();
    // The same id twice is the same handle, whatever the punctuation around it.
    expect(passShortId('pas_01J9Z8K4Q7')).toBe(passShortId('01J9Z8K4Q7'));
  });

  it('reads the receipt from the landed stage alone', () => {
    const landed = event('landed', 5, { span, tokens: { in: 120_000, out: 6_099 }, costUsd: 0.08 });
    expect(receiptOf(landed)).toEqual({ tokens: 126_099, costUsd: 0.08, durationMs: null });
    expect(receiptOf(landed, [...READING, landed]).durationMs).toBe(T0 + 5 * MIN - T0);
    expect(receiptOf(null)).toEqual({ tokens: null, costUsd: null, durationMs: null });
  });

  it('prints the tokens, the money only when a rate measured it, and never a price label', () => {
    expect(receiptTextOf({ tokens: 126_099, costUsd: 0.08, durationMs: null })).toBe('126\u00a0099\u00a0токенов\u00a0·\u00a00,08\u00a0$');
    expect(receiptTextOf({ tokens: 126_099, costUsd: null, durationMs: null })).toBe('126\u00a0099\u00a0токенов');
    expect(receiptTextOf({ tokens: null, costUsd: 0.08, durationMs: null })).toBe('0,08\u00a0$');
    expect(receiptTextOf({ tokens: null, costUsd: null, durationMs: null })).toBeNull();
    for (const receipt of [
      receiptTextOf({ tokens: 126_099, costUsd: null, durationMs: null }) ?? '',
      receiptTextOf({ tokens: null, costUsd: null, durationMs: null }) ?? '',
    ]) {
      expect(receipt).not.toContain('цена');
    }
  });
});

describe('the strip’s head', () => {
  it('says what the book is doing, where, and since when', () => {
    const live = passStripModel({ chapter: 7, events: [...READING, event('drafting', 4)], nowMs: T0 + 5 * MIN });
    expect(live.phase).toBe('live');
    expect(live.heading).toBe('книга пишется\u00a0·\u00a0глава 7\u00a0·\u00a011:18');
    // Live: the stage the pass is on now.
    expect(live.right).toBe(RAIL_WORDS.drafting);
  });

  it('reads a landed pass in the past tense and states how long it ran', () => {
    const landed = event('landed', 5, { span, tokens: { in: 120_000, out: 6_099 }, costUsd: 0.08 });
    const ended = passStripModel({ chapter: 7, events: [...READING, event('drafting', 4), landed], nowMs: T0 + 9 * MIN });
    expect(ended.phase).toBe('ended');
    expect(ended.heading).toBe('писалась\u00a0·\u00a0глава 7\u00a0·\u00a011:18');
    expect(ended.right).toBe('5\u00a0мин');
    expect(ended.receipt.tokens).toBe(126_099);
    expect(ended.refused).toBe(false);
  });

  it('marks a refused pass and has nothing to receive', () => {
    const refused = passStripModel({ chapter: 7, events: [...READING, event('refused', 3)], nowMs: T0 + 9 * MIN });
    expect(refused.refused).toBe(true);
    expect(refused.rows.at(-1)?.word).toBe(RAIL_WORDS.refused);
    expect(receiptTextOf(refused.receipt)).toBeNull();
  });

  it('claims no pass when no stage was stored — the absence, in words', () => {
    const empty = passStripModel({ chapter: 7, events: [], nowMs: T0 });
    // A failed `getStages` is not liveness: no lead, no time, no row (BOOK-199, audit #2).
    expect(empty.phase).toBe('absent');
    expect(empty.heading).toBe('пока ничего не записано\u00a0·\u00a0глава 7');
    expect(empty.heading).not.toContain('пишется');
    expect(empty.rows).toEqual([]);
    expect(empty.right).toBeNull();
    expect(empty.receipt).toEqual({ tokens: null, costUsd: null, durationMs: null });
    expect(empty.refused).toBe(false);
    // Lowercase, as every mark line is.
    expect(empty.heading).toBe(empty.heading.toLowerCase());
  });
});

describe('the live row’s lines', () => {
  it('wraps one event line into at most three lines of forty characters', () => {
    const lines = factLines('писатель читает главу и решает, что поправить в двенадцатом абзаце этой главы');
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines.join(' ')).toContain('писатель читает');
  });

  it('never grows the rail: a long line is cut at three', () => {
    expect(factLines('раз два три четыре пять шесть семь восемь девять десять одиннадцать двенадцать', 5, 3)).toHaveLength(3);
    expect(factLines('')).toEqual([]);
    // One word longer than the line is cut, never allowed to widen the row.
    const long = 'слово'.repeat(20);
    expect(factLines(long, 40, 3)).toEqual([long.slice(0, 40)]);
  });
});

describe('the log’s own helpers', () => {
  it('narrows a chapter’s log to one pass, in stage order', () => {
    const other = event('drafting', 1, { passId: 'stp_other', at: T0 + 10 * MIN });
    const own = eventsOfPass([event('verdict', 3), other, event('read', 2)], 'stp_01J9Z8K4Q7');
    expect(own.map((one) => one.stage)).toEqual(['read', 'verdict']);
    expect(latestPassId([event('verdict', 3), other])).toBe('stp_other');
  });

  it('merges the stored answer and the live frames, live winning', () => {
    const stored = [event('read', 2, { summary: 'старая строка' }), event('verdict', 3)];
    const live = [event('drafting', 4), event('verdict', 3, { summary: 'новая строка' })];
    const merged = mergeStages(stored, live);
    expect(merged.map((one) => one.stage)).toEqual(['read', 'verdict', 'drafting']);
    expect(merged[1]?.summary).toBe('новая строка');
  });
});

describe('the block a pass is writing', () => {
  const landed = event('landed', 5, { span });
  const typing = event('typing', 6);

  it('takes the landed span and starts at the typing moment', () => {
    const spec = livePassOf([...READING, event('drafting', 4), landed, typing]);
    expect(spec).not.toBeNull();
    expect(spec?.startAt).toBe(typing.at);
    expect(spec?.blockId).toBe('ch07#bbbb2222');
    expect(spec?.after).toBe(span[0]!.after);
  });

  it('has nothing to paint for a pass that only read', () => {
    expect(livePassOf(READING)).toBeNull();
    expect(livePassOf([...READING, event('refused', 3)])).toBeNull();
  });

  it('paints the block the page still holds by id, and its successor by text', () => {
    const spec = livePassOf([landed, typing])!;
    const before = liveRunOf(spec, { id: 'ch07#bbbb2222', text: span[0]!.before });
    expect(before?.text).toBe(span[0]!.after);
    expect(before?.span.kind).toBe('replacement');
    const after = liveRunOf(spec, { id: 'ch07#cccc3333', text: span[0]!.after });
    expect(after?.text).toBe(span[0]!.after);
    // A paragraph the pass did not touch is not painted.
    expect(liveRunOf(spec, { id: 'ch07#aaaa1111', text: 'Первый абзац.' })).toBeNull();
  });

  it('waits for the chapter when the stage’s side was cut at the bound', () => {
    const cut = event('landed', 5, { span: [{ ...span[0]!, truncated: true }] });
    const spec = livePassOf([cut, typing])!;
    expect(liveRunOf(spec, { id: 'ch07#bbbb2222', text: span[0]!.before })).toBeNull();
  });

  it('is keyed by the pass: a later `typing` names the clock, never a second renderer', () => {
    const landedOnly = livePassOf([landed])!;
    expect(landedOnly.key).toBe(landed.passId);
    // Either order in the log: `typing` usually arrives after `landed` (the tailer publishes in
    // seq order), and the renderer must not be re-keyed by it — a re-keyed renderer re-types an
    // inked block.
    expect(livePassOf([landed, typing])?.key).toBe(landedOnly.key);
    expect(livePassOf([typing, landed])?.key).toBe(landedOnly.key);
    // The clock is still the typing moment when it exists, and the landing's own when it does not.
    expect(landedOnly.startAt).toBe(landed.at);
    expect(livePassOf([landed, typing])?.startAt).toBe(typing.at);
    // A typing whose own seq comes first is not a clock that started before the words existed.
    const earlyTyping = event('typing', 4, { at: T0 + 4 * MIN });
    expect(livePassOf([earlyTyping, landed])?.key).toBe(landedOnly.key);
    expect(livePassOf([earlyTyping, landed])?.startAt).toBe(landed.at);
  });

  it('paints a block the pass only shortened: the deletion, not a skip', () => {
    const shortened = event('landed', 5, {
      span: [{ blockId: 'ch07#bbbb2222', before: 'шум реки затих', after: '', truncated: false }],
    });
    const spec = livePassOf([shortened, typing]);
    expect(spec).not.toBeNull();
    // No entry carries words to write, so the one that carries words to remove is the span.
    expect(spec?.before).toBe('шум реки затих');
    expect(spec?.after).toBe('');
    const run = liveRunOf(spec!, { id: 'ch07#bbbb2222', text: 'шум реки затих' });
    expect(run?.span.kind).toBe('deletion');
    expect(run?.span.before).toBe('шум реки затих');
    expect(run?.text).toBe('');
  });

  it('finds the last event of one stage', () => {
    expect(passStageAt([...READING, event('typing', 6)], 'typing')?.stageSeq).toBe(6);
    expect(passStageAt(READING, 'landed')).toBeNull();
  });
});
