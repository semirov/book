import type { ChangeDto, ChangeImpactDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Ribbon } from '../lib/cascade.ts';
import { FocusView } from './FocusView.tsx';

const change: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
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
    seams: [],
    gates: { cycles: 2, findingSurvived: false },
    tokens: { total: 150_572 },
    ms: 41_000,
  },
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
      seamsOut: [],
      charsDelta: 41,
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
      seamsIn: [],
      seamsOut: [],
      charsDelta: -9,
      note: null,
      at: '2026-10-25T12:01:00Z',
      cycles: 0,
      findingSurvived: false,
    },
    {
      seq: 3,
      wave: 1,
      wing: 'upward',
      chapter: 9,
      pass: 'cascade',
      boundary: 9,
      outcome: 'holds',
      revBefore: 1,
      revAfter: 1,
      seamsIn: [],
      seamsOut: [],
      charsDelta: 0,
      note: null,
      at: '2026-10-25T12:02:00Z',
      cycles: 0,
      findingSurvived: false,
    },
  ],
  appliedRevs: [
    { chapter: 7, rev: 3 },
    { chapter: 8, rev: 4 },
  ],
  cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 30_572, rub: 0.04 },
  history: { fromHseq: 10, toHseq: 14 },
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

const impact: ChangeImpactDto = {
  changeId: 'chg_1',
  chaptersTouched: [8, 7, 9],
  chaptersRewritten: [8, 7],
  blocksChanged: 4,
  charsAdded: 41,
  charsRemoved: 9,
  overwrites: 0,
  seams: [],
  depth: { down: 1, up: 1 },
  tokens: 150_572,
  costRub: 0.04,
  ms: 41_000,
  history: { fromHseq: 10, toHseq: 14 },
  computedAt: '2026-10-25T12:05:00Z',
};

function ribbon(step: number | null): Ribbon {
  return {
    changeId: 'chg_1',
    cascadeId: 'csc_1',
    chapter: 8,
    wave: 1,
    status: 'open',
    outcome: null,
    touched: [8, 7, 9],
    rewritten: [8],
    step,
    frontier: { down: 7, up: 9 },
    seams: [],
  };
}

const GATE_WORDS = ['вердикт', 'findings', 'редактор', 'консультант', 'HOLDS', 'GAP', 'gate'];

function ringLeft(html: string): number {
  const match = /class="focus-ring"[^>]*style="left:([\d.]+)%"/u.exec(html);
  expect(match).not.toBeNull();
  return Number(match?.[1] ?? Number.NaN);
}

describe('the focus view', () => {
  it('shows the intent, the footnote, the cost and the actions', () => {
    const html = renderToStaticMarkup(
      <FocusView change={change} impact={impact} missing={false} ribbon={null} revisions={{}} onClose={() => undefined} />,
    );
    expect(html).toContain('прицел');
    expect(html).toContain('правка 014');
    expect(html).toContain('выйти');
    expect(html).toContain('в абзаце дважды «слово»');
    expect(html).toContain('сноска 014');
    expect(html).toContain('итерация 014 · волна 2 из 5');
    expect(html).toContain('волна 2 из 5 · этап: готово');
    expect(html).toContain('волна 2 / 5');
    expect(html).toContain('deepseek-flash');
    expect(html).toContain('0,04');
    expect(html).toContain('07 · 08 · 09 (проверена)');
    expect(html).toContain('к главе 8');
    expect(html).toContain('слежу');
  });

  it('reads the wave bound from the frame and stays sane without one', () => {
    // The server announces its own bound (BOOK-DOC-4 rule 3): the panel must not carry a 3.
    const fromFrame = renderToStaticMarkup(
      <FocusView
        change={change}
        impact={impact}
        missing={false}
        ribbon={null}
        maxWave={4}
        revisions={{}}
        onClose={() => undefined}
      />,
    );
    expect(fromFrame).toContain('волна 2 / 4');
    expect(fromFrame).toContain('итерация 014 · волна 2 из 4');
    expect(fromFrame).toContain('волна 2 из 4 · этап: готово');
    expect(fromFrame).not.toContain('из 3');
    // Before `hello` lands the fallback is the shipped default, not a broken readout.
    const noFrame = renderToStaticMarkup(
      <FocusView change={change} impact={impact} missing={false} ribbon={null} revisions={{}} onClose={() => undefined} />,
    );
    expect(noFrame).toContain('волна 2 / 5');
  });

  it('never renders a gate field, a finding or a hidden role', () => {
    const html = renderToStaticMarkup(
      <FocusView change={change} impact={impact} missing={false} ribbon={ribbon(7)} revisions={{}} onClose={() => undefined} />,
    ).toLowerCase();
    for (const word of GATE_WORDS) expect(html).not.toContain(word.toLowerCase());
  });

  it('moves the ring and the lit sheet from 7 to 9 as the ripple moves', () => {
    const live: ChangeDto = { ...change, status: 'processing', decidedAt: null, steps: [change.steps[0]!] };
    const at7 = renderToStaticMarkup(
      <FocusView change={live} impact={impact} missing={false} ribbon={ribbon(7)} revisions={{}} onClose={() => undefined} />,
    );
    const at9 = renderToStaticMarkup(
      <FocusView change={live} impact={impact} missing={false} ribbon={ribbon(9)} revisions={{}} onClose={() => undefined} />,
    );
    expect(at7).toContain('data-chapter="7"');
    expect(at7).toContain('глава 07');
    expect(at9).toContain('data-chapter="9"');
    expect(at9).toContain('глава 09');
    expect(ringLeft(at9)).toBeGreaterThan(ringLeft(at7));
    expect(at7).toContain('вниз: глава 7 · вверх: глава 9');
    expect(at7).toContain('вниз');
  });

  it('shows a dropped change’s reason and does not type', () => {
    const dropped: ChangeDto = {
      ...change,
      status: 'void',
      outcome: 'dropped',
      reason: 'в главе уже одно упоминание — второе убрано',
      cascade: null,
      steps: [],
      appliedRevs: [],
      cost: null,
    };
    const html = renderToStaticMarkup(
      <FocusView change={dropped} impact={null} missing={false} ribbon={null} revisions={{}} onClose={() => undefined} />,
    );
    expect(html).toContain('снято');
    expect(html).toContain('в главе уже одно упоминание — второе убрано');
    expect(html).not.toContain('class="focus-p"');
    expect(html).toContain('шагов нет');
  });

  it('shows the relevance grade of a change whose base moved', () => {
    const stale: ChangeDto = {
      ...change,
      status: 'stale',
      relevance: {
        grade: 'partial',
        revAtRecord: 3,
        revNow: 5,
        anchor: 'moved',
        applies: 'partial',
        overlap: 0.5,
        chapterRewritten: false,
        evidence: ['абзац сдвинулся на две позиции'],
        reason: null,
      },
    };
    const html = renderToStaticMarkup(
      <FocusView change={stale} impact={impact} missing={false} ribbon={null} revisions={{}} onClose={() => undefined} />,
    );
    expect(html).toContain('основа изменилась');
    expect(html).toContain('основа изменилась частично');
    expect(html).toContain('абзац сдвинулся на две позиции');
    expect(html).not.toContain('class="focus-p"');
  });

  it('keeps an old link honest instead of inventing a change', () => {
    const html = renderToStaticMarkup(
      <FocusView change={null} impact={null} missing ribbon={null} revisions={{}} onClose={() => undefined} />,
    );
    expect(html).toContain('правка не найдена');
    expect(html).toContain('выйти');
  });
});
