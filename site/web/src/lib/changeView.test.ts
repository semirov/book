import type { ChangeDto, CommentDto } from '@book/shared';
import { describe, expect, it } from 'vitest';

import { changeBefore, changeView } from './changeView.ts';

/**
 * The record's `правка` section is a function of the change and the record's own anchor: the
 * numeral, the two sentences, the state with its moment, the outcome and one line per step.
 * These are the rows the section prints, checked without a browser.
 */

const change: ChangeDto = {
  premiseLanded: false,
  id: 'chg_1',
  seq: 9,
  kind: 'accepted_comment',
  interventionKind: 'document',
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
  cost: null,
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T11:59:00Z',
  startedAt: '2026-10-25T12:00:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
};

const filing: CommentDto = {
  attempt: null,
  id: 'cmt_1',
  chapter: 8,
  anchor: { blockId: 'ch08#a', blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
  author: 'Аня',
  authorColor: '#2e6274',
  body: 'в комнате должен быть свет',
  interventionKind: 'document',
  proposedText: null,
  premise: false,
  status: 'applied',
  frame: 'untouched',
  reason: null,
  createdAt: '2026-10-25T12:04:00Z',
  decidedAt: '2026-10-25T12:05:00Z',
  changeId: 'chg_1',
  applied: { chapter: 8, rev: 4 },
  refusal: null,
};

describe('the change in the record’s register', () => {
  it('prints the numeral, both sentences, the state with its moment and the outcome', () => {
    const view = changeView(change, 'Её освещал яркий свет.', 'Её освещал ровный свет.');
    expect(view.numeral).toBe('009');
    expect(view.before).toBe('Её освещал яркий свет.');
    expect(view.after).toBe('Её освещал ровный свет.');
    expect(view.state).toBe('внесено');
    expect(view.stamp).toMatch(/^25\.10, \d{2}:\d{2}$/u);
    expect(view.verdict).toBe('внесено');
  });

  it('states a stopped change as one sentence in the book’s terms, never a gate word', () => {
    const stopped: ChangeDto = {
      ...change,
      status: 'failed',
      outcome: 'rights',
      reason: 'чужая цитата без источника',
      decidedAt: '2026-10-25T12:05:00Z',
    };
    const view = changeView(stopped, null, null);
    expect(view.verdict).toBe('правка не внесена: чужая цитата без источника');
    for (const gone of ['не принято', 'мин', 'сек', 'ждал', 'читал', 'писал', 'сверял']) {
      expect(view.verdict, gone).not.toContain(gone);
    }
    // A change still running says only that it is not in the book yet.
    expect(changeView({ ...change, status: 'processing', outcome: null, reason: null }, null, null).verdict).toBe(
      'правка ещё не внесена',
    );
    // A stopped change with no public reason states the fact once.
    expect(changeView({ ...stopped, reason: null }, null, null).verdict).toBe('правка не внесена');
  });

  it('carries one line per step and the author’s words for the author’s own change', () => {
    const view = changeView(change, null, null);
    expect(view.steps).toEqual([{ key: '1-2026-10-25T12:00:00Z', text: 'глава 8 переписана' }]);
    expect(view.intent).toBe('в абзаце дважды «слово» — оставить одно упоминание');
    // No filing, no sentence: the section prints the intent instead of inventing a quote.
    expect(view.before).toBeNull();
  });

  it('reads the filing’s own quote as the sentence the change found', () => {
    expect(changeBefore(change, [filing])).toBe('Её освещал яркий свет.');
    // A filing the record does not hold (or another change's) is not this change's before.
    expect(changeBefore(change, [])).toBeNull();
    expect(changeBefore(change, [{ ...filing, id: 'cmt_other' }])).toBeNull();
    expect(changeBefore({ ...change, source: { commentId: null, author: null } }, [filing])).toBeNull();
  });
});
