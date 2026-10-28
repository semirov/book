import type { ChangeCostDto, ChangeDto, ChangeImpactDto, HistoryRecordDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChangeCard } from './ChangeCard.tsx';
import { FocusView } from './FocusView.tsx';
import { RecordRow } from './RecordRow.tsx';

/**
 * «Honesty about cost» (BOOK-DOC-4, BOOK-23): every surface prints the model and the tokens,
 * and the money **only when it was measured**. An unmeasured cost travels as `null`; a zero
 * that is a real price prints «0,00 ₽» — the two are different values on the wire, and no
 * surface is allowed to dress one up as the other.
 */

const NBSP = '\u00a0';

function change(cost: ChangeCostDto | null): ChangeDto {
  return {
    premiseLanded: false,
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
    outcome: 'applied',
    reason: null,
    position: null,
    relevance: null,
    cascade: null,
    modes: [],
    steps: [],
    appliedRevs: [],
    cost,
    scienceCheck: null,
    history: null,
    enqueuedAt: '2026-10-25T11:59:00Z',
    startedAt: '2026-10-25T12:00:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
  };
}

function impact(costRub: number | null): ChangeImpactDto {
  return {
    changeId: 'chg_1',
    chaptersTouched: [8],
    chaptersRewritten: [8],
    blocksChanged: 1,
    charsAdded: 41,
    charsRemoved: 9,
    overwrites: 0,
    seams: [],
    depth: { down: 0, up: 0 },
    tokens: 150_572,
    costRub,
    ms: 41_000,
    history: { fromHseq: 10, toHseq: 14 },
    computedAt: '2026-10-25T12:05:00Z',
  };
}

const record: HistoryRecordDto = {
  id: 'chg_1',
  hseq: 7,
  at: '2026-10-25T12:05:00Z',
  seq: 7,
  chapter: 8,
  chapterTitle: null,
  premise: false,
  premiseLanded: false,
  alias: 'Аня',
  cause: 'reader',
  status: 'done',
  outcome: 'applied',
  reason: null,
  changeId: 'chg_1',
  recordHref: '#правка-chg_1',
  span: null,
};

/** The three public surfaces a reader meets a change on: card, focus view, chronicle row. */
function surfaces(cost: ChangeCostDto | null, costRub: number | null): string {
  const card = change(cost);
  return [
    renderToStaticMarkup(<ChangeCard change={card} onClose={() => undefined} />),
    renderToStaticMarkup(
      <FocusView
        change={card}
        impact={impact(costRub)}
        missing={false}
        ribbon={null}
        revisions={{}}
        onClose={() => undefined}
      live />,
    ),
    renderToStaticMarkup(<RecordRow record={record} />),
  ].join('\n');
}

const tokensAndModel: ChangeCostDto = { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub: null };

describe('the change surfaces never print a price that was not measured', () => {
  it('shows the tokens and never the model id, and no ₽ figure at all', () => {
    const markup = surfaces(tokensAndModel, null);
    expect(markup).not.toContain('deepseek');
    expect(markup).toContain(`150${NBSP}572${NBSP}токена`);
    expect(markup).not.toContain('₽');
    expect(markup).not.toContain('0,00');
  });

  it('prints the figure for a cost that was measured', () => {
    const markup = surfaces({ ...tokensAndModel, rub: 0.04 }, 0.04);
    expect(markup).toContain(`0,04${NBSP}₽`);
  });

  it('prints a measured zero, so «free» is not read as «never measured»', () => {
    // The wire tells them apart: `rub: null` is absence and prints nothing; `rub: 0` is a
    // price and prints «0,00 ₽». That DTO is reachable — a change row with `cost_priced = 1`
    // and `cost_rub = 0` is exercised through the real API in `server/test/engineState.test.ts`.
    const free = surfaces({ ...tokensAndModel, rub: 0 }, 0);
    const unmeasured = surfaces(tokensAndModel, null);
    expect(free).toContain(`0,00${NBSP}₽`);
    expect(free).toContain('class="change-cost"');
    expect(unmeasured).not.toContain('₽');
  });

  it('prints no ₽ for a money value that cannot be a price', () => {
    const broken = surfaces({ ...tokensAndModel, rub: Number.NaN }, Number.NaN);
    expect(broken).not.toContain('₽');
    expect(broken).not.toContain('NaN');
  });

  it('says nothing about money when no price source exists at all, and keeps the tokens', () => {
    // A change whose tokens were never frozen falls back to the impact projection: the
    // projection's own money is absent too, so the focus view prints tokens only.
    const markup = surfaces(null, null);
    expect(markup).toContain(`150${NBSP}572${NBSP}токена`);
    expect(markup).not.toContain('₽');
  });
});
