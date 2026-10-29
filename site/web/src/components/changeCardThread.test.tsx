import type { ChangeSummaryDto, CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Discussion } from './Discussion.tsx';

/**
 * BOOK-136 / BOOK-137 — the thread's two-line status, split out of `changeCard.test.tsx` when
 * the union of the two branches' tests outgrew the 500-line file bound. One filing is one
 * entry; its second line names the attempt, and the change is never a row of its own.
 */

describe('the thread’s two-line status', () => {
  const summary: ChangeSummaryDto = {
    premiseLanded: false,
    sourceCommentId: 'cmt_1',
    id: 'chg_1',
    seq: 14,
    chapter: 8,
    intent: 'в абзаце дважды «слово»',
    premise: false,
    status: 'done',
    frame: 'untouched',
    frameMode: null,
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

  it('folds the change into its filing: one entry, one number, one change door (BOOK-137)', () => {
    const comment: CommentDto = {
      attempt: null,
      id: 'cmt_1',
      chapter: 8,
      anchor: { blockId: 'ch08#aa11', blockIndex: 2, quote: 'слово', prefix: null, suffix: null, resolved: true },
      author: 'Аня',
      authorColor: '#2e6274',
      body: 'тут дважды «слово»',
      interventionKind: null,
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
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[comment]} changes={[summary]} live />);
    // The state line is the filing's (BOOK-136), and the attempt is one quiet line under it.
    expect(html).toContain('внесено');
    expect(html).toContain('<span class="attempt-n">014</span>');
    expect(html).toContain('href="?change=chg_1"');
    expect(html).toContain('правка →');
    // One entry: the change is never a row of its own beside the filing it came from.
    expect(html.match(/data-comment-id="cmt_1"/gu) ?? []).toHaveLength(1);
    expect(html.match(/правка →/gu) ?? []).toHaveLength(1);
    expect(html).not.toContain('data-change="chg_1"');
    expect(html).not.toContain('class="talks-list"');
  });

  it('links a comment with a change straight into the record’s правка section', () => {
    const comment: CommentDto = {
      attempt: null,
      id: 'cmt_1',
      chapter: 8,
      anchor: { blockId: 'ch08#aa11', blockIndex: 2, quote: 'слово', prefix: null, suffix: null, resolved: true },
      author: 'Аня',
      authorColor: '#2e6274',
      body: 'тут дважды «слово»',
      interventionKind: null,
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
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[comment]} live />);
    expect(html).toContain('href="?change=chg_1"');
    expect(html).toContain('правка →');
  });

  it('keeps the empty thread quiet', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} live />);
    // BOOK-DOC-34: the register carries no form, so it promises nothing about notes opening.
    // BOOK-59: the «Глав ещё нет» line is gone — it named a «замечание» where the product says
    // «замысел», and the empty slot already carries that word (premise.ts).
    expect(html).not.toContain('Замечания откроются');
    expect(html).not.toContain('станет её замыслом');
  });
});
