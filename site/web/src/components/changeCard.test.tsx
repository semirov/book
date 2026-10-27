import type { ChangeDto, ChangeSummaryDto, CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CascadeRibbon } from './CascadeRibbon.tsx';
import { ChangeCard } from './ChangeCard.tsx';
import { Discussion } from './Discussion.tsx';
import type { Ribbon } from '../lib/cascade.ts';

const change: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: {
    grade: 'rebased',
    revAtRecord: 3,
    revNow: 5,
    anchor: 'moved',
    applies: 'yes',
    overlap: 0.93,
    chapterRewritten: false,
    evidence: ['абзац сдвинулся на две позиции', 'дефект на месте'],
    reason: null,
  },
  cascade: {
    id: 'csc_1',
    status: 'closed',
    outcome: 'consistent',
    wave: 2,
    depth: { forward: 1, backward: 1 },
    chaptersChecked: [9],
    chaptersRewritten: [8, 7],
    seams: [
      { boundary: 8, reason: 'в главе 8 ключ теперь у другого', resolved: true },
      { boundary: 7, reason: 'в главе 7 сказано иначе', resolved: false },
    ],
    wings: {
      down: { frontier: 7, wave: 1, state: 'settled', reached: [7] },
      up: { frontier: 9, wave: 1, state: 'settled', reached: [9] },
    },
    modes: ['оформление'],
    gates: { cycles: 2, findingSurvived: true },
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
      outcome: 'published_with_finding',
      revBefore: 3,
      revAfter: 4,
      seamsIn: [],
      seamsOut: [{ boundary: 8, reason: 'в главе 8 ключ теперь у другого' }],
      charsDelta: 41,
      note: 'правка 3 · замечание сохранено',
      at: '2026-10-25T12:00:00Z',
      cycles: 3,
      findingSurvived: true,
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
      seamsOut: [{ boundary: 7, reason: 'в главе 7 сказано иначе' }],
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
  modes: ['оформление'],
  history: { fromHseq: 10, toHseq: 14 },
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

const GATE_WORDS = ['вердикт', 'findings', 'редактор', 'консультант', 'HOLDS', 'GAP', 'gate'];

describe('ChangeCard', () => {
  it('shows the quoted intent, the steps, the seams and the outcome', () => {
    const html = renderToStaticMarkup(<ChangeCard change={change} onClose={() => undefined} />);
    expect(html).toContain('правка 014 · глава 8');
    expect(html).toContain('в абзаце дважды «слово»');
    expect(html).toContain('формулировка автора · из замечания Аня');
    expect(html).toContain('основа сдвинулась, правка перенесена');
    expect(html).toContain('глава 8 переписана · замечание сохранено');
    expect(html).toContain('глава 7 переписана');
    expect(html).toContain('глава 9 проверена, правок нет');
    expect(html).toContain('7 | 8');
    expect(html).toContain('6 | 7');
    expect(html).toContain('в главе 7 сказано иначе');
    expect(html).toContain('стык пересматривается');
    expect(html).toContain('внесено');
    expect(html).toContain('0.04 ₽');
    expect(html).toContain('href="#правка-chg_1"');
  });

  it('never renders a gate field, a finding or a hidden role', () => {
    const html = renderToStaticMarkup(<ChangeCard change={change} onClose={() => undefined} />).toLowerCase();
    for (const word of GATE_WORDS) expect(html).not.toContain(word.toLowerCase());
  });

  it('shows the public reason of a dropped change and no typing', () => {
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
    const html = renderToStaticMarkup(<ChangeCard change={dropped} onClose={() => undefined} />);
    expect(html).toContain('снято');
    expect(html).toContain('в главе уже одно упоминание — второе убрано');
    expect(html).toContain('шагов пока нет');
  });

  it('renders the outcome as делопроизводство, with the cause and its mode', () => {
    const html = renderToStaticMarkup(<ChangeCard change={change} onClose={() => undefined} />);
    expect(html).toContain('class="change-deed"');
    expect(html).toContain(
      'зарегистрировано · заведено дело · внесены изменения · причина установлена · оформление',
    );
    expect(html).not.toContain('исправлен');
  });

  it('says which wing reached a chapter and why, and opens that chapter', () => {
    const html = renderToStaticMarkup(
      <ChangeCard change={change} onClose={() => undefined} onOpenChapter={() => undefined} />,
    );
    expect(html).toContain('class="step-wing">вниз');
    expect(html).toContain('class="step-wing">вверх');
    expect(html).toContain('class="step-wing">здесь');
    expect(html).toContain('в главе 8 ключ теперь у другого');
    expect(html.match(/class="step-open"/g) ?? []).toHaveLength(3);
  });

  it('names the finale a финал, not the wing that never walks into it', () => {
    const ended: ChangeDto = {
      ...change,
      chapter: 66,
      cascade: {
        ...change.cascade!,
        chaptersRewritten: [66],
        wings: {
          down: { frontier: 65, wave: 1, state: 'settled', reached: [65] },
          up: { frontier: 66, wave: 0, state: 'settled', reached: [] },
        },
      },
      steps: [
        {
          ...change.steps[0]!,
          chapter: 66,
          boundary: 67,
          seamsOut: [{ boundary: 'ending', reason: 'финал держится' }],
        },
        {
          ...change.steps[1]!,
          seq: 4,
          chapter: 67,
          wing: null,
          pass: 'ending',
          boundary: 'ending',
          outcome: 'evaluated',
          seamsIn: [{ boundary: 'ending', reason: 'финал держится' }],
          seamsOut: [],
        },
      ],
    };
    const html = renderToStaticMarkup(<ChangeCard change={ended} onClose={() => undefined} />);
    expect(html).toContain('class="step-wing">финал');
    expect(html).not.toContain('step-wing">вверх');
  });

  it('files a change with no step and no mode as registered only', () => {
    const pending: ChangeDto = {
      ...change,
      status: 'pending',
      position: 1,
      cascade: null,
      steps: [],
      modes: [],
      appliedRevs: [],
      cost: null,
      decidedAt: null,
    };
    const html = renderToStaticMarkup(<ChangeCard change={pending} onClose={() => undefined} />);
    expect(html).toContain('зарегистрировано');
    expect(html).not.toContain('заведено дело');
    expect(html).not.toContain('внесены изменения');
    expect(html).not.toContain('причина установлена');
  });
});

describe('the thread’s two-line status', () => {
  const summary: ChangeSummaryDto = {
    id: 'chg_1',
    seq: 14,
    chapter: 8,
    intent: 'в абзаце дважды «слово»',
    status: 'done',
    outcome: 'applied',
    reason: null,
    position: null,
    enqueuedAt: '2026-10-25T11:59:00Z',
    decidedAt: '2026-10-25T12:05:00Z',
    chapters: [8, 7, 9],
    rewritten: [8, 7],
    steps: 3,
    modes: ['оформление'],
    cascade: { id: 'csc_1', status: 'closed', outcome: 'consistent' },
  };

  it('renders both lines and the trace, and reaches the прицел in one tap', () => {
    const html = renderToStaticMarkup(<Discussion depth={3} chapterCount={8} changes={[summary]} />);
    expect(html).toContain('принято');
    expect(html).toContain('внесено');
    expect(html).toContain('дошло до глав 7 и 9');
    expect(html).toContain('принято → внесено → дошло до глав 7 и 9');
    expect(html).toContain('прицел 014');
    expect(html).toContain('href="#правка-chg_1"');
    expect(html).not.toContain('черновик');
  });

  it('links a comment with a change straight into the прицел', () => {
    const comment: CommentDto = {
      id: 'cmt_1',
      chapter: 8,
      anchor: { blockId: 'ch08#aa11', blockIndex: 2, quote: 'слово', prefix: null, suffix: null, resolved: true },
      author: 'Аня',
      authorColor: '#2e6274',
      body: 'тут дважды «слово»',
      interventionKind: null,
      proposedText: null,
      status: 'applied',
      reason: null,
      createdAt: '2026-10-25T12:04:00Z',
      decidedAt: '2026-10-25T12:05:00Z',
      changeId: 'chg_1',
      applied: { chapter: 8, rev: 4 },
    };
    const html = renderToStaticMarkup(<Discussion depth={0} chapterCount={8} comments={[comment]} />);
    expect(html).toContain('href="#правка-chg_1"');
    expect(html).toContain('прицел →');
  });

  it('keeps the empty thread quiet', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} chapterCount={0} />);
    expect(html).toContain('Замечания откроются вместе с первой главой');
  });
});

describe('CascadeRibbon', () => {
  const ribbon: Ribbon = {
    changeId: 'chg_1',
    cascadeId: 'csc_1',
    chapter: 8,
    wave: 1,
    status: 'open',
    outcome: null,
    touched: [7, 8, 9],
    rewritten: [8],
    wings: {
      down: { frontier: 7, wave: 1, state: 'moving', reached: [7] },
      up: { frontier: 9, wave: 1, state: 'moving', reached: [9] },
    },
    step: 9,
    frontier: { down: 7, up: 9 },
    seams: [{ boundary: 9, reason: 'в главе 9 ключ теперь у другого', resolved: false }],
  };

  it('draws the origin, the touched chapters, the step and the dashed seam', () => {
    const html = renderToStaticMarkup(
      <CascadeRibbon
        ribbon={ribbon}
        markers={[
          { key: 'chg_1:9', boundary: 9, reason: 'budget', note: 'ключ теперь у другого', changeId: 'chg_1' },
        ]}
        onOpenChange={() => undefined}
      />,
    );
    expect(html).toContain('aria-label="правка: глава 8 · вниз до главы 7 · вверх до главы 9"');
    expect(html).toContain('ribbon-origin');
    // Both wings at once: each with its own wave and state, each chapter a link to itself.
    expect(html).toContain('вниз · волна 1 · идёт');
    expect(html).toContain('вверх · волна 1 · идёт');
    expect(html).toContain('href="#ch-7"');
    expect(html).toContain('href="#ch-8"');
    expect(html).toContain('href="#ch-9"');
    expect(html.match(/class="ribbon-ring"/g) ?? []).toHaveLength(3);
    expect(html).toContain('стык пересматривается');
    expect(html).toContain('ключ теперь у другого');
    expect(html).not.toContain('style=');
  });

  it('draws no rings without a live cascade, and no wing that never opened', () => {
    const quiet = renderToStaticMarkup(
      <CascadeRibbon
        ribbon={{
          ...ribbon,
          status: 'closed',
          step: null,
          wings: {
            down: { frontier: 8, wave: 0, state: 'waiting', reached: [] },
            up: { frontier: 8, wave: 0, state: 'waiting', reached: [] },
          },
        }}
        markers={[]}
        onOpenChange={() => undefined}
      />,
    );
    expect(quiet).not.toContain('ribbon-ring');
    expect(quiet.match(/class="ribbon-none"/g) ?? []).toHaveLength(2);
    expect(quiet.match(/не открылось/g) ?? []).toHaveLength(2);
  });

  it('still draws an escalated seam when no ripple is running', () => {
    const html = renderToStaticMarkup(
      <CascadeRibbon
        ribbon={null}
        markers={[{ key: 'chg_1:7', boundary: 7, reason: 'budget', note: null, changeId: null }]}
        onOpenChange={() => undefined}
      />,
    );
    expect(html).toContain('ribbon-seam');
    expect(html).toContain('6 | 7');
    expect(html).not.toContain('ribbon-wings');
    expect(html).not.toContain('ribbon-ring');
  });

  it('draws nothing when there is neither a ripple nor a seam', () => {
    expect(renderToStaticMarkup(<CascadeRibbon ribbon={null} markers={[]} onOpenChange={() => undefined} />)).toBe('');
  });
});
