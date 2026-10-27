import type { ChangeDto, CommentDto } from '@book/shared';
import { INTERVENTION_KINDS, INTERVENTION_KIND_LABELS } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChangeCard } from './ChangeCard.tsx';
import { Discussion } from './Discussion.tsx';
import { InterventionKinds } from './InterventionKinds.tsx';

/**
 * BOOK-16 — the four kinds on the surfaces a reader sees.
 *
 * The composer offers them as a plain choice with nothing pre-selected; the thread and the
 * change card print the one Russian word beside the decision. No id, no gate role and no
 * hidden taxonomy reaches the markup: the kind is a world-fact the rules page already names.
 */

const IDS = ['document', 'decision', 'testimony', 'erasure'];
const TAXONOMY = ['FITS', 'OFF', 'аудитор', 'редактор', 'консультант'];

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_1',
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'В главе 8 подписан отказ на пропуск.',
    proposedText: 'Отказ подписан.',
    interventionKind: 'testimony',
    premise: false,
    status: 'accepted',
    reason: 'входит в книгу',
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: '2026-10-25T12:05:00Z',
    changeId: 'chg_1',
    applied: null,
    ...overrides,
  };
}

const change: ChangeDto = {
  id: 'chg_1',
  seq: 14,
  kind: 'accepted_comment',
  interventionKind: 'document',
  chapter: 8,
  intent: 'подписан отказ на пропуск',
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
  steps: [],
  appliedRevs: [{ chapter: 8, rev: 4 }],
  cost: null,
  scienceCheck: null,
  history: null,
  enqueuedAt: '2026-10-25T12:05:00Z',
  startedAt: '2026-10-25T12:06:00Z',
  decidedAt: '2026-10-25T12:30:00Z',
};

describe('the composer’s kinds (BOOK-16)', () => {
  const html = renderToStaticMarkup(<InterventionKinds kind={null} onPick={() => undefined} />);

  it('offers four radios, the four Russian labels and the bounds line', () => {
    for (const label of Object.values(INTERVENTION_KIND_LABELS)) {
      expect(html).toContain(label);
    }
    expect(html).toContain('что вы вносите: документ · решение героя · свидетельство · стёртая деталь');
    // BOOK-57: the note left the grid, so exactly four choices remain.
    expect(html.match(/type="radio"/gu) ?? []).toHaveLength(INTERVENTION_KINDS.length);
    // The bound is grouped with the non-breaking space the rest of the site uses.
    expect(html).toContain('до 10\u00a0000 знаков · одна правка в сутки');
  });

  it('keeps the note out of the grid: no fifth row and no lecture', () => {
    expect(html).not.toContain('просто замечание');
    expect(html).not.toContain('без типа');
    expect(html).not.toContain('одного из четырёх типов');
    expect(html).not.toContain('вмешательство');
  });

  it('pre-selects nothing: the reader names the kind', () => {
    expect(html).not.toContain('checked');
    expect(html).toContain('тип не выбран — без него правка не уйдёт');
    expect(html).toContain('data-kind="none"');
  });

  it('shows the chosen kind in the draft state', () => {
    const chosen = renderToStaticMarkup(<InterventionKinds kind="decision" onPick={() => undefined} />);
    expect(chosen).toContain('вносится: решение героя');
    expect(chosen).toContain('data-kind="decision"');
    // Exactly one radio is checked, and it is the chosen one.
    expect(chosen.match(/checked/gu) ?? []).toHaveLength(1);
    expect(chosen).toMatch(/checked=""[^>]*value="decision"|value="decision"[^>]*checked=""/u);
  });
});

describe('the kind in the thread and on the change card (BOOK-16)', () => {
  it('prints the kind beside the decision, as one plain word', () => {
    const html = renderToStaticMarkup(<Discussion depth={2} comments={[comment()]} live />);
    // The kind sits in front of the decision, one word, inside the same line.
    // BOOK-90: the state is the word «идёт»; the queue fact is the detail.
    expect(html).toContain('<span class="comment-kind">свидетельство · </span>идёт');
    expect(html).toContain('правка в очереди на запись · входит в книгу');
  });

  it('prints nothing for a note or a row stored before BOOK-16', () => {
    const html = renderToStaticMarkup(
      <Discussion depth={2} comments={[comment({ interventionKind: null, proposedText: null })]} live />,
    );
    expect(html).toContain('замечание в очереди · входит в книгу');
    expect(html).not.toContain('свидетельство');
  });

  it('names the kind on the change card and leaks no id or gate role', () => {
    const html = renderToStaticMarkup(<ChangeCard change={change} onClose={() => undefined} />);
    expect(html).toContain('вносит документ');
    for (const id of IDS) expect(html, id).not.toContain(id);
    for (const word of TAXONOMY) expect(html, word).not.toContain(word);
  });

  it('keeps the id out of the thread too', () => {
    const html = renderToStaticMarkup(<Discussion depth={2} comments={[comment()]} live />);
    for (const id of IDS) expect(html, id).not.toContain(id);
    for (const word of TAXONOMY) expect(html, word).not.toContain(word);
  });
});
