import type { ChapterDto, PassStageEvent } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { MIDDOT, NBSP } from './format.ts';
import {
  PASS_NEVER,
  costSentence,
  durationText,
  parsePassRecordHash,
  passRecordHash,
  passRecordView,
  tokensText,
  type PassRecordInput,
} from './passRecord.ts';

/**
 * BOOK-166 — the pass record's model: the hash, the two states and every word on the page.
 *
 * The fixtures are stored moments in UTC; the page prints them in the site's timezone
 * (Europe/Moscow, +3), so 08:18Z reads as 11:18. Nothing here touches a browser or a socket.
 */

/** `2026-10-25T08:18:00Z` = 11:18 in Moscow. */
const T0 = Date.parse('2026-10-25T08:18:00Z');
const T1 = Date.parse('2026-10-25T08:19:00Z');
const T2 = Date.parse('2026-10-25T08:20:00Z');
/** 11:20:56 — 2 мин 56 с after the first stage. */
const T3 = Date.parse('2026-10-25T08:20:56Z');
/** 11:21:56 — the browser's own moment, one minute after the pass had already landed. */
const T4 = Date.parse('2026-10-25T08:21:56Z');

const stage = (over: Partial<PassStageEvent> & Pick<PassStageEvent, 'stage' | 'stageSeq' | 'at'>): PassStageEvent => ({
  passId: 'stp_1',
  chapter: 7,
  actor: { process: 'writer', model: null },
  changeId: 'chg_1',
  summary: 'глава 7 пишется',
  span: null,
  tokens: null,
  costUsd: null,
  ...over,
});

const LIVE = [
  stage({ stage: 'queued', stageSeq: 1, at: T0 }),
  stage({ stage: 'read', stageSeq: 2, at: T1 }),
  stage({ stage: 'drafting', stageSeq: 3, at: T2 }),
];

const LANDED = [
  stage({ stage: 'read', stageSeq: 1, at: T0 }),
  stage({ stage: 'verdict', stageSeq: 2, at: T1 }),
  stage({ stage: 'drafting', stageSeq: 3, at: T2 }),
  stage({
    stage: 'landed',
    stageSeq: 4,
    at: T3,
    span: [{ blockId: null, before: 'старый фонарь', after: 'новый фонарь', truncated: false }],
    tokens: { in: 100_000, out: 26_099 },
    costUsd: 0.08,
  }),
];

/** Twelve paragraphs, the last one the landed span's own text. */
const CHAPTER: Pick<ChapterDto, 'title' | 'blocks'> = {
  title: 'Дорога',
  blocks: Array.from({ length: 12 }, (_, index) => ({
    id: `ch07#${String(index)}`,
    i: index,
    text: index === 11 ? 'новый фонарь' : `абзац ${String(index + 1)}`,
    hash: 'h',
  })),
};

const input = (over: Partial<PassRecordInput> = {}): PassRecordInput => ({
  key: { kind: 'change', changeId: 'chg_1' },
  stages: LANDED,
  change: {
    chapter: 7,
    status: 'done',
    outcome: 'applied',
    startedAt: '2026-10-25T08:18:00Z',
    enqueuedAt: '2026-10-25T08:15:00Z',
    decidedAt: '2026-10-25T08:20:56Z',
    cost: { tokensIn: 100_000, tokensOut: 26_099 },
  },
  chapter: CHAPTER,
  anchorIndex: 11,
  nowMs: T3,
  ...over,
});

describe('the record’s one id', () => {
  it('round-trips a change: #проход-<changeId>', () => {
    const key = { kind: 'change' as const, changeId: 'chg_9' };
    expect(passRecordHash(key)).toBe('#проход-chg_9');
    expect(parsePassRecordHash('#проход-chg_9')).toEqual(key);
    expect(parsePassRecordHash('#проход-chg_9?x=1')).toBeNull();
  });

  it('round-trips a landed pass with no change row: #проход-<chapter>-<passId>', () => {
    const key = { kind: 'pass' as const, chapter: 7, passId: 'stp_1' };
    expect(passRecordHash(key)).toBe('#проход-7-stp_1');
    expect(parsePassRecordHash('#проход-7-stp_1')).toEqual(key);
    // A chapter outside the book is not a record: the book never had that pass.
    expect(parsePassRecordHash('#проход-99-stp_1')).toBeNull();
    expect(parsePassRecordHash('#проход-0-stp_1')).toBeNull();
  });

  it('is not the change card’s link and not a malformed key', () => {
    expect(parsePassRecordHash('#чужое-chg_9')).toBeNull();
    expect(parsePassRecordHash('#проход-')).toBeNull();
    expect(parsePassRecordHash('#проход-7-')).toBeNull();
    expect(parsePassRecordHash('chg_9')).toBeNull();
    expect(parsePassRecordHash('#проход-%E0%A4%A')).toBeNull();
  });
});

describe('live: the pass is writing now', () => {
  it('says «книга пишется», the chapter, the first stored moment and the stage', () => {
    const view = passRecordView(
      input({ stages: LIVE, chapter: null, nowMs: T2 + 14_000 }),
    );

    expect(view.phase).toBe('live');
    expect(view.head).toBe(`книга пишется${MIDDOT}глава 7${MIDDOT}11:18`);
    expect(view.stageWord).toBe('пишется');
    expect(view.finalWord).toBeNull();
    expect(view.since).toBe(`с начала 2${NBSP}мин 14${NBSP}с`);
    expect(view.paragraph).toBe(12);
    // The timeline is present tense; the stage the pass is on now is marked.
    expect(view.timeline.map((step) => step.word)).toEqual(['ждёт', 'читает', 'пишется']);
    expect(view.timeline.map((step) => step.time)).toEqual(['11:18', '11:19', '11:20']);
    expect(view.timeline.map((step) => step.current)).toEqual([false, false, true]);
    // No money while the pass is running, and the link goes to the block being printed.
    expect(view.cost).toBeNull();
    expect(view.href).toBe('#pass');
    expect(view.link).toBe('к абзацу 12 →');
  });

  it('falls back to the chapter’s head when the paragraph cannot be named', () => {
    const view = passRecordView(input({ stages: LIVE, chapter: null, anchorIndex: null, nowMs: T2 }));
    expect(view.paragraph).toBeNull();
    expect(view.link).toBe('к главе 7 →');
  });
});

describe('ended: the pass is over', () => {
  it('says «писалась», the final word, the duration and the whole timeline', () => {
    const view = passRecordView(input());

    expect(view.phase).toBe('ended');
    expect(view.head).toBe(`писалась${MIDDOT}глава 7${MIDDOT}11:18`);
    expect(view.finalWord).toBe('внесено');
    expect(view.stageWord).toBeNull();
    expect(view.duration).toBe(`2${NBSP}мин 56${NBSP}с`);
    expect(view.timeline.map((step) => `${step.word} ${step.time}`)).toEqual([
      'читал 11:18',
      'сверял 11:19',
      'писал 11:20',
      'внёс 11:20',
    ]);
    expect(view.timeline.some((step) => step.current)).toBe(false);
    // The pair, then one cost sentence with nouns — no price label, no model.
    expect(view.span).toEqual({ before: 'старый фонарь', after: 'новый фонарь' });
    expect(view.cost).toBe(`126${NBSP}099${NBSP}токенов${MIDDOT}0,08${NBSP}$`);
    // The block is gone from the chapter, so the link lands on the chapter's head.
    expect(view.href).toBe('#ch-7');
    expect(view.link).toBe(`к главе 7${MIDDOT}абзац 12 →`);
    expect(view.chapterTitle).toBe('Дорога');
  });

  it('keeps the print delay out of the past: no «печатал», and the clock ends at the landing', () => {
    // Every change-driven write stores `typing` above `landed`: the browser printing what the
    // pass had already written. It is the landing's delay, not a step the pass took.
    const printed = [...LANDED, stage({ stage: 'typing', stageSeq: 5, at: T4 })];
    const view = passRecordView(input({ stages: printed }));

    expect(view.timeline.map((step) => `${step.word} ${step.time}`)).toEqual([
      'читал 11:18',
      'сверял 11:19',
      'писал 11:20',
      'внёс 11:20',
    ]);
    // …and it does not stretch the duration: the pass was over when its words landed.
    expect(view.duration).toBe(`2${NBSP}мин 56${NBSP}с`);
  });

  it('prints «не принято» for a refused pass and no span it never wrote', () => {
    const refused = [
      stage({ stage: 'read', stageSeq: 1, at: T0 }),
      stage({ stage: 'refused', stageSeq: 2, at: T1, summary: 'права: отказ' }),
    ];
    const view = passRecordView(input({ stages: refused, change: null }));
    expect(view.finalWord).toBe('не принято');
    expect(view.span).toBeNull();
    expect(view.cost).toBeNull();
    expect(view.duration).toBe(`1${NBSP}мин`);
  });

  it('does not invent a span from an empty or unchanged pair', () => {
    const created = [
      stage({ stage: 'landed', stageSeq: 1, at: T0, span: [{ blockId: null, before: '', after: 'новая глава', truncated: false }] }),
    ];
    expect(passRecordView(input({ stages: created })).span).toBeNull();
  });
});

describe('a change with no stored stage: the row is the truth that is left', () => {
  it('reads the change’s own moments and its tokens, and invents no stage', () => {
    const view = passRecordView(input({ stages: [] }));
    expect(view.phase).toBe('ended');
    expect(view.head).toBe(`писалась${MIDDOT}глава 7${MIDDOT}11:18`);
    expect(view.finalWord).toBe('внесено');
    expect(view.duration).toBe(`2${NBSP}мин 56${NBSP}с`);
    expect(view.timeline).toEqual([]);
    expect(view.span).toBeNull();
    expect(view.cost).toBe(`126${NBSP}099${NBSP}токенов${MIDDOT}цена не задана`);
  });

  it('reads a running change with no stored stage from its own start, never a stage', () => {
    const view = passRecordView(
      input({
        stages: [],
        change: { ...input().change!, status: 'processing', outcome: null, decidedAt: null },
        nowMs: T2,
      }),
    );
    expect(view.phase).toBe('live');
    expect(view.head).toBe(`книга пишется${MIDDOT}глава 7${MIDDOT}11:18`);
    expect(view.stageWord).toBe('пишется');
    expect(view.since).toBe(`с начала 2${NBSP}мин`);
    expect(view.timeline).toEqual([]);
    expect(view.cost).toBeNull();
    expect(view.href).toBe('#pass');
  });

  it('says «пока не писалась» for a change that never reached a pass', () => {
    const view = passRecordView(input({ stages: [], change: { ...input().change!, status: 'pending', decidedAt: null } }));
    expect(view.phase).toBe('absent');
    expect(view.head).toBe(PASS_NEVER);
    // Nothing was written: the way out is the contents, never a chapter it cannot name a pass in.
    expect(view.link).toBe('к оглавлению');
    expect(view.cost).toBeNull();
  });
});

describe('nothing to tell', () => {
  it('says «пока не писалась» and points at the contents for an unknown id', () => {
    const view = passRecordView(input({ key: { kind: 'change', changeId: 'chg_gone' }, stages: [], change: null, chapter: null }));
    expect(view.phase).toBe('absent');
    expect(view.head).toBe('пока не писалась');
    expect(view.href).toBe('#toc');
    expect(view.link).toBe('к оглавлению');
    expect(view.timeline).toEqual([]);
    expect(view.cost).toBeNull();
  });

  it('keeps the chapter it knows but still offers the contents when only the pass is unknown', () => {
    const view = passRecordView(
      input({ key: { kind: 'pass', chapter: 7, passId: 'stp_missing' }, stages: [], change: null, chapter: CHAPTER }),
    );
    expect(view.chapter).toBe(7);
    expect(view.chapterTitle).toBe('Дорога');
    expect(view.href).toBe('#toc');
    expect(view.link).toBe('к оглавлению');
  });
});

describe('a change with several passes takes the one that landed', () => {
  it('prefers a landed pass over a later attempt that never wrote', () => {
    const retry = [stage({ passId: 'stp_2', stage: 'queued', stageSeq: 1, at: T3 })];
    const view = passRecordView(input({ stages: [...retry, ...LANDED] }));
    expect(view.phase).toBe('ended');
    expect(view.finalWord).toBe('внесено');
  });
});

describe('the book’s numbers and durations', () => {
  it('writes a duration with its nouns and non-breaking spaces', () => {
    expect(durationText(14_000)).toBe(`14${NBSP}с`);
    expect(durationText(134_000)).toBe(`2${NBSP}мин 14${NBSP}с`);
    expect(durationText(176_000)).toBe(`2${NBSP}мин 56${NBSP}с`);
    expect(durationText(3_600_000)).toBe(`1${NBSP}ч`);
    expect(durationText(-1)).toBeNull();
    expect(durationText(Number.NaN)).toBeNull();
  });

  it('never counts tokens without their noun, and never prices an unmeasured pass', () => {
    expect(tokensText(126_099)).toBe(`126${NBSP}099${NBSP}токенов`);
    expect(tokensText(0)).toBeNull();
    expect(costSentence(null, null)).toBeNull();
    expect(costSentence(126_099, 0.08)).toBe(`126${NBSP}099${NBSP}токенов${MIDDOT}0,08${NBSP}$`);
    expect(costSentence(126_099, null)).toBe(`126${NBSP}099${NBSP}токенов${MIDDOT}цена не задана`);
  });
});
