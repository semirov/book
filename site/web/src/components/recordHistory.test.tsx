import type { CommentDto, ParagraphChainDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { historyRows, rowWindow } from '../lib/recState.ts';
import { RowsList } from './RecordParts.tsx';

/**
 * BOOK-220 §11.3 — **the history guard**: every state the record can open, rendered, and the
 * rows are checked as text.
 *
 * A row may never carry a placeholder (`пара не записана`, `null`, `undefined`, `NaN`), an id
 * (`cmt_…`, `chg_…`), a machine noun (`change`, `step`, `verdict`, `гейт`) or a second copy of
 * another row. Each row answers when, who and what: `28.10, 00:24 · вы предложили эту правку`.
 */

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#b1',
  chapter: 8,
  alive: true,
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 1,
      blockId: 'ch08#b1',
      chapter: 8,
      rev: 1,
      at: '2026-10-21T21:03:00Z',
      op: 'introduced',
      textHash: 'h1',
      chars: 20,
      changeId: null,
      changeSeq: null,
      stepId: null,
      actor: { kind: 'writer', label: 'печатник', identityId: 'id1' },
      replacedBy: null,
    },
    {
      blockUid: 'bkd_1',
      ver: 2,
      blockId: 'ch08#b1',
      chapter: 8,
      rev: 2,
      at: '2026-10-28T21:29:00Z',
      op: 'revised',
      textHash: 'h2',
      chars: 20,
      changeId: 'chg_12',
      changeSeq: 12,
      stepId: null,
      actor: { kind: 'reader', label: 'Аня', identityId: 'id2' },
      replacedBy: null,
    },
  ],
  line: 'печатник',
};

function filing(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    number: 12,
    chapter: 8,
    anchor: { blockId: 'ch08#b1', blockIndex: 0, quote: 'Её освещал тусклый свет.', prefix: null, suffix: null, resolved: true },
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
    createdAt: '2026-10-28T21:24:00Z',
    decidedAt: null,
    changeId: 'chg_12',
    changeSeq: 12,
    applied: null,
    ...overrides,
  };
}

/** Every state the record's `история` can be opened over. */
const FIXTURES: Array<{ name: string; filing: CommentDto | null; failed?: boolean }> = [
  { name: 'no filing', filing: null },
  { name: 'new', filing: filing() },
  { name: 'accepted', filing: filing({ status: 'accepted', changeStatus: 'processing' }) },
  { name: 'applied', filing: filing({ status: 'applied', applied: { chapter: 8, rev: 2 } }) },
  { name: 'registered', filing: filing({ status: 'registered', reason: 'оформление · фраза не изменилась' }) },
  { name: 'refused by the law', filing: filing({ status: 'rejected', refusal: 'rights', reason: 'не принято: пересказ' }) },
  { name: 'refused by the auditor', filing: filing({ status: 'rejected', refusal: 'auditor', reason: 'вне книги' }) },
  { name: 'stopped by us', filing: filing({ status: 'rejected', reason: 'правка остановлена — текст остался прежним' }), failed: true },
  { name: 'failed attempt', filing: filing({ attempt: 'failed' }), failed: true },
  { name: 'held', filing: filing({ status: 'quarantined' }) },
  { name: 'superseded', filing: filing({ status: 'superseded' }) },
  { name: 'expired', filing: filing({ status: 'expired' }) },
  { name: 'no change number yet', filing: filing({ changeId: null, changeSeq: null }) },
];

const TEXT = (): string => {
  const parts: string[] = [];
  for (const fixture of FIXTURES) {
    for (const chain of [null, CHAIN] as const) {
      const rows = historyRows({
        chain,
        filing: fixture.filing,
        viewer: 'Филипп',
        quote: 'Её освещал яркий свет.',
        failed: fixture.failed === true,
      });
      parts.push(renderToStaticMarkup(<RowsList rows={rowWindow(rows, true)} lifted history onLift={() => undefined} onFold={() => undefined} />));
    }
  }
  return parts.join('\n');
};

describe('the history guard', () => {
  it('renders no placeholder for any state', () => {
    const html = TEXT();
    for (const word of ['пара не записана', 'null', 'undefined', 'NaN', 'пара']) {
      expect(html, word).not.toContain(word);
    }
  });

  it('prints no id and no machine noun', () => {
    const html = TEXT();
    for (const word of ['cmt_', 'chg_', 'bkd_', 'change', 'step', 'verdict', 'гейт', '№']) {
      expect(html, word).not.toContain(word);
    }
  });

  it('answers when, who and what on every row', () => {
    for (const fixture of FIXTURES) {
      const rows = historyRows({ chain: CHAIN, filing: fixture.filing, viewer: 'Филипп', quote: 'Её освещал яркий свет.', failed: fixture.failed === true });
      for (const row of rows) {
        expect(row.facts, fixture.name).toMatch(/^\d\d\.\d\d, \d\d:\d\d · (вы |читатель |машина |никто ).+$/u);
      }
    }
  });

  it('never repeats a row verbatim', () => {
    const html = TEXT();
    for (const block of html.split('<div class="rec-rows">').slice(1)) {
      const facts = [...block.matchAll(/<p class="rec-row-facts">([^<]*)<\/p>/gu)].map((match) => match[1] ?? '');
      expect(new Set(facts).size, block.slice(0, 120)).toBe(facts.length);
    }
  });
});
