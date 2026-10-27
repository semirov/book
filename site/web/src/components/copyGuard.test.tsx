import type { ChangeDto, HistoryRecordDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Ribbon } from '../lib/cascade.ts';
import { CascadeRibbon } from './CascadeRibbon.tsx';
import { ChangeCard } from './ChangeCard.tsx';
import { Chronicle } from './Chronicle.tsx';
import { FocusView } from './FocusView.tsx';
import { ParagraphChain } from './ParagraphChain.tsx';
import { RecordRow } from './RecordRow.tsx';

/**
 * The copy guard (BOOK-15, BOOK-19): reader-facing words the book may not say.
 *
 * The retrospection is **оформляется, never masked**, so no surface may call a seam a «шов»,
 * announce that a contradiction was fixed, call a stretch of text «битый», use the trade's
 * word «retcon», or name a gate role the reader was never told about. Checked in the rendered
 * markup of every surface that can print them; the copy modules those surfaces render from
 * are scanned beside this test (`server/test/copy.test.ts`, where reading source files is
 * allowed). «Стык пересматривается» is the book's own word for the seam and stays.
 *
 * BOOK-76: the physics pass is now named to the reader — one line on the change card, and
 * `/rules` names the whole chain once. The ban therefore drops «консультант» and keeps every
 * other role, the verdict words and the findings vocabulary the payload still does not carry.
 *
 * BOOK-DOC-43 §6 (BOOK-66): a placeholder may not promise progress it does not measure, so
 * the skeleton's own vocabulary is banned too. The surfaces this pass touched (the chronicle
 * and the paragraph chain) are printed here as well, so the guard is not vacuous for them.
 */

const BANNED = [
  'шов',
  'противоречие исправлено',
  'битый',
  'retcon',
  'редактор',
  'аудитор',
  'почти готово',
  'осталось',
  'подождите немного',
];

const change: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  source: { commentId: null, author: null },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'adapted',
  reason: null,
  position: null,
  relevance: null,
  cascade: {
    id: 'csc_1',
    status: 'closed',
    outcome: 'consistent',
    wave: 2,
    depth: { forward: 1, backward: 1 },
    chaptersChecked: [9],
    chaptersRewritten: [8, 7],
    seams: [{ boundary: 8, reason: 'в главе 8 ключ теперь у другого', resolved: true }],
    wings: {
      down: { frontier: 7, wave: 2, state: 'settled', reached: [7] },
      up: { frontier: 9, wave: 2, state: 'settled', reached: [9] },
    },
    modes: ['поправка', 'расхождение'],
    gates: { cycles: 1, findingSurvived: false },
    tokens: { total: 100 },
    ms: 1_000,
  },
  modes: ['поправка', 'расхождение'],
  steps: [
    {
      seq: 1,
      wave: 0,
      wing: null,
      chapter: 8,
      pass: 'change',
      boundary: 8,
      outcome: 'rewritten',
      revBefore: 3,
      revAfter: 4,
      seamsIn: [],
      seamsOut: [{ boundary: 8, reason: 'в главе 8 ключ теперь у другого' }],
      charsDelta: 10,
      note: null,
      at: '2026-10-25T12:00:00Z',
      cycles: 1,
      findingSurvived: false,
    },
    {
      seq: 2,
      wave: 1,
      wing: 'downward',
      chapter: 7,
      pass: 'cascade',
      boundary: 7,
      outcome: 'rewritten',
      revBefore: 2,
      revAfter: 3,
      seamsIn: [{ boundary: 8, reason: 'в главе 8 ключ теперь у другого' }],
      seamsOut: [],
      charsDelta: -4,
      note: null,
      at: '2026-10-25T12:01:00Z',
      cycles: 0,
      findingSurvived: false,
    },
  ],
  appliedRevs: [{ chapter: 8, rev: 4 }],
  cost: null,
  scienceCheck: 'passed',
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

const ribbon: Ribbon = {
  changeId: 'chg_1',
  cascadeId: 'csc_1',
  chapter: 8,
  wave: 2,
  status: 'escalated',
  outcome: 'escalated',
  touched: [7, 8, 9],
  rewritten: [8, 7],
  wings: {
    down: { frontier: 7, wave: 2, state: 'settled', reached: [7] },
    up: { frontier: 9, wave: 2, state: 'stopped', reached: [9] },
  },
  step: null,
  frontier: { down: 7, up: 9 },
  seams: [{ boundary: 9, reason: 'в главе 9 ключ теперь у другого', resolved: false }],
};

const record: HistoryRecordDto = {
  hseq: 7,
  at: '2026-10-25T12:05:00Z',
  seq: 7,
  chapter: 8,
  premise: false,
  alias: 'Аня',
  status: 'done',
  outcome: 'adapted',
  reason: null,
  changeId: 'chg_1',
};

function surfaces(): string {
  return [
    renderToStaticMarkup(<ChangeCard change={change} onClose={() => undefined} onOpenChapter={() => undefined} />),
    renderToStaticMarkup(
      <CascadeRibbon
        ribbon={ribbon}
        markers={[{ key: 'chg_1:9', boundary: 9, reason: 'budget', note: 'ключ теперь у другого', changeId: 'chg_1' }]}
        onOpenChange={() => undefined}
      live />,
    ),
    renderToStaticMarkup(
      <FocusView change={change} impact={null} missing={false} ribbon={ribbon} revisions={{}} onClose={() => undefined} live />,
    ),
    renderToStaticMarkup(<RecordRow record={record} onOpenChange={() => undefined} />),
    renderToStaticMarkup(<Chronicle catalog={[]} frontRev={1} tick={0} onOpenChange={() => undefined} live />),
    renderToStaticMarkup(
      <ParagraphChain
        chain={null}
        loading={false}
        failed
        onClose={() => undefined}
        onRetry={() => undefined}
        live
      />,
    ),
  ].join('\n');
}

describe('the reader-facing copy guard', () => {
  it('never says a banned word on any surface', () => {
    const markup = surfaces().toLowerCase();
    for (const word of BANNED) expect(markup).not.toContain(word);
  });

  it('renders the modes as paperwork, never as a repair', () => {
    const markup = surfaces();
    expect(markup).toContain('причина установлена · поправка: пункт изложен в новой редакции');
    expect(markup).toContain('расхождение зафиксировано');
    expect(markup).toContain('стык пересматривается');
  });

  it('prints the physics pass as one line, and nothing while it has not answered', () => {
    const card = (scienceCheck: ChangeDto['scienceCheck']): string =>
      renderToStaticMarkup(<ChangeCard change={{ ...change, scienceCheck }} onClose={() => undefined} />);
    expect(card('passed')).toContain('<dt>проверка</dt><dd>пройдена · научный консультант</dd>');
    expect(card('failed')).toContain('<dt>проверка</dt><dd>не пройдена · научный консультант</dd>');
    expect(card(null)).not.toContain('<dt>проверка</dt>');
  });
});
