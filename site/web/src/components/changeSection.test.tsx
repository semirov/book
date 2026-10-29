import type { ChangeDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChangeSection } from './ChangeSection.tsx';

/**
 * The `правка` section is the book's register: the change's numeral, what was before and after,
 * a state word and a verdict in the reader's terms. A stopped change is one sentence —
 * «правка не внесена: <why>» — never the engine's report card (no gate word, no stage, no
 * duration, no token or money line).
 */

const change: ChangeDto = {
  premiseLanded: false,
  id: 'chg_1',
  seq: 9,
  kind: 'accepted_comment',
  interventionKind: null,
  chapter: 8,
  intent: 'в абзаце дважды «слово» — оставить одно упоминание',
  premise: false,
  source: { commentId: 'cmt_1', author: 'Аня' },
  base: { rev: 3 },
  scopeHint: 'phrase',
  status: 'done',
  outcome: 'applied',
  reason: null,
  position: null,
  relevance: null,
  cascade: null,
  modes: [],
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
  ],
  appliedRevs: [{ chapter: 8, rev: 4 }],
  cost: { model: 'deepseek-flash', tokensIn: 120_000, tokensOut: 66_411, rub: 0.19 },
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

const stopped: ChangeDto = {
  ...change,
  status: 'done',
  outcome: 'rights',
  reason: 'чужая цитата без источника',
};

describe('the change’s verdict in the record', () => {
  it('prints the numeral, the sentence before and after, and a landed verdict', () => {
    const html = renderToStaticMarkup(
      <ChangeSection change={change} before="Её освещал яркий свет." after="Её освещал ровный свет." />,
    );
    expect(html).toContain('было');
    expect(html).toContain('«Её освещал яркий свет.»');
    expect(html).toContain('стало');
    expect(html).toContain('«Её освещал ровный свет.»');
    expect(html).toContain('внесено');
    // The cost is the author's console: no token count, no money in the reader's section.
    expect(html).not.toContain('токен');
    expect(html).not.toContain('₽');
    expect(html).not.toContain('$');
    expect(html).not.toContain('deepseek');
  });

  it('states a stopped change as «правка не внесена: …», never a gate word or a duration', () => {
    const html = renderToStaticMarkup(<ChangeSection change={stopped} before={null} after={null} />);
    expect(html).toContain('правка не внесена: чужая цитата без источника');
    for (const gone of ['не принято', 'мин', 'сек', 'ждал', 'читал', 'писал', 'сверял', 'внёс']) {
      // A whole word: the intent's «упоминание» is prose, not a duration.
      expect(new RegExp(`(^|[^\\p{L}])${gone}([^\\p{L}]|$)`, 'u').test(html), gone).toBe(false);
    }
  });
});
