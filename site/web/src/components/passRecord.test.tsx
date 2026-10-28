import type { ChapterDto, PassStageEvent } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PASS_NEVER, passRecordView } from '../lib/passRecord.ts';
import type { PassRecordSession } from '../lib/usePassRecord.ts';
import { MIDDOT, NBSP } from '../lib/format.ts';
import { PassRecord } from './PassRecord.tsx';

/**
 * BOOK-166 — the record's reader-facing copy, rendered as the page ships it.
 *
 * Live: «книга пишется», the stage in its present tense, «с начала …», the timeline and the
 * block link. Ended: «писалась», the final word, the past timeline, «было» → «стало», one
 * cost sentence, the chapter's title and the way back. Absent: «пока не писалась».
 *
 * The text is checked for the owner's bans as text, not as markup: no «этап:», no «готово», no
 * «цена» label (the unpriced fallback «цена не задана» is the one allowed phrase), no model id
 * and never the internal noun for a pass.
 */

const T0 = Date.parse('2026-10-25T08:18:00Z');
const T1 = Date.parse('2026-10-25T08:19:00Z');
const T2 = Date.parse('2026-10-25T08:20:00Z');
const T3 = Date.parse('2026-10-25T08:20:56Z');

const stage = (over: Partial<PassStageEvent> & Pick<PassStageEvent, 'stage' | 'stageSeq' | 'at'>): PassStageEvent => ({
  passId: 'stp_1',
  chapter: 7,
  actor: { process: 'writer', model: null },
  changeId: 'chg_1',
  summary: 'глава 7',
  span: null,
  tokens: null,
  costUsd: null,
  ...over,
});

const CHAPTER: Pick<ChapterDto, 'title' | 'blocks'> = {
  title: 'Дорога',
  blocks: Array.from({ length: 12 }, (_, index) => ({
    id: `ch07#${String(index)}`,
    i: index,
    text: index === 11 ? 'новый фонарь' : `абзац ${String(index + 1)}`,
    hash: 'h',
  })),
};

const change = {
  chapter: 7,
  status: 'done' as const,
  outcome: 'applied' as const,
  startedAt: '2026-10-25T08:18:00Z',
  enqueuedAt: '2026-10-25T08:15:00Z',
  decidedAt: '2026-10-25T08:20:56Z',
  cost: { tokensIn: 100_000, tokensOut: 26_099 },
};

const LIVE = passRecordView({
  key: { kind: 'change', changeId: 'chg_1' },
  stages: [
    stage({ stage: 'read', stageSeq: 1, at: T0 }),
    stage({ stage: 'drafting', stageSeq: 2, at: T2 }),
  ],
  change,
  chapter: null,
  anchorIndex: 11,
  nowMs: T2 + 14_000,
});

const ENDED = passRecordView({
  key: { kind: 'change', changeId: 'chg_1' },
  stages: [
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
  ],
  change,
  chapter: CHAPTER,
  anchorIndex: 11,
  nowMs: T3,
});

const ABSENT = passRecordView({
  key: { kind: 'change', changeId: 'chg_gone' },
  stages: [],
  change: null,
  chapter: null,
  anchorIndex: null,
  nowMs: T3,
});

function session(view: typeof LIVE): PassRecordSession {
  return { phase: 'ready', hash: '#проход-chg_1', key: { kind: 'change', changeId: 'chg_1' }, view };
}

const textOf = (html: string): string => html.replace(/<[^>]+>/gu, '');

function assertReaderSurface(markup: string): void {
  const text = textOf(markup);
  expect(text).not.toContain('этап:');
  expect(text).not.toContain('готово');
  expect(text).not.toContain('проход');
  expect(text).not.toContain('deepseek');
  expect(text).not.toMatch(/проход(?:а|ы|ов|у|ом|е)?(?![а-яё])/u);
  // «цена» is allowed only in the book's own phrase for an unmeasured price.
  expect(text.replace(/цена не задана/gu, '')).not.toContain('цена');
}

describe('the live record', () => {
  it('prints the exact head, the stage, the elapsed time and the paragraph', () => {
    const html = renderToStaticMarkup(<PassRecord state={session(LIVE)} />);

    expect(html).toContain(`<h2 class="pr-head">книга пишется${MIDDOT}глава 7${MIDDOT}11:18</h2>`);
    // The 5 × 5 live square and the stage in its present tense.
    expect(html).toContain('<span class="pr-square" aria-hidden="true"></span>');
    expect(html).toContain('пишется');
    expect(html).toContain(`с начала 2${NBSP}мин 14${NBSP}с${MIDDOT}абзац 12`);
    // The timeline in the present, the current stage marked.
    expect(html).toContain('читает');
    expect(html).toContain('is-current');
    expect(html).toContain('aria-current="step"');
    // No money before the pass has landed, and the link goes to the live block.
    expect(html).not.toContain('pr-cost');
    expect(html).toContain('href="#pass"');
    expect(html).toContain('к абзацу 12 →');
    assertReaderSurface(html);
  });
});

describe('the ended record', () => {
  it('prints the exact head, the word, the duration, the past timeline, the pair and the cost', () => {
    const html = renderToStaticMarkup(<PassRecord state={session(ENDED)} />);

    expect(html).toContain(`<h2 class="pr-head">писалась${MIDDOT}глава 7${MIDDOT}11:18</h2>`);
    expect(html).toContain('<span class="pr-final">внесено</span>');
    expect(html).toContain(`2${NBSP}мин 56${NBSP}с`);
    // One row, each word with its time, one space between them.
    for (const line of ['читал 11:18', 'сверял 11:19', 'писал 11:20', 'внёс 11:20']) {
      expect(html).toMatch(new RegExp(`<span class="pr-word">${line.split(' ')[0]}</span> <span class="pr-time">${line.split(' ')[1]}</span>`, 'u'));
    }
    // «было» → «стало», typographic quotes, exactly one arrow.
    expect(html).toContain('<p class="pr-span">«старый фонарь» → «новый фонарь»</p>');
    expect((html.match(/→/gu) ?? []).length).toBe(2); // the span's arrow and the link's
    expect(html).toContain(
      `<p class="pr-cost">126${NBSP}099${NBSP}токенов${MIDDOT}0,08${NBSP}$</p>`,
    );
    // The chapter's title where it is a title, and the way back to the block.
    expect(html).toContain('<span class="pr-place">«Дорога»</span>');
    expect(html).toContain('href="#ch-7"');
    expect(html).toContain(`к главе 7${MIDDOT}абзац 12 →`);
    assertReaderSurface(html);
  });

  it('says «не принято» and invents neither a span nor a price', () => {
    const refused = passRecordView({
      key: { kind: 'change', changeId: 'chg_1' },
      stages: [
        stage({ stage: 'read', stageSeq: 1, at: T0 }),
        stage({ stage: 'refused', stageSeq: 2, at: T1 }),
      ],
      change: { ...change, status: 'void', outcome: 'dropped' },
      chapter: null,
      anchorIndex: null,
      nowMs: T1,
    });
    const html = renderToStaticMarkup(<PassRecord state={session(refused)} />);
    expect(html).toContain('<span class="pr-final">не принято</span>');
    expect(html).not.toContain('pr-span');
    expect(html).not.toContain('pr-cost');
    assertReaderSurface(html);
  });
});

describe('nothing to tell', () => {
  it('says «пока не писалась» and offers the contents', () => {
    const html = renderToStaticMarkup(<PassRecord state={session(ABSENT)} />);
    expect(html).toContain(`<h2 class="pr-head">${PASS_NEVER}</h2>`);
    expect(html).toContain('href="#toc"');
    expect(html).toContain('к оглавлению');
    expect(html).not.toContain('pr-cost');
    assertReaderSurface(html);
  });
});
