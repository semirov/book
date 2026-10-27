import { AUTHOR_COLORS, type CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { commentStatusLine } from '../lib/commentView.ts';
import { FilingPanel } from './FilingPanel.tsx';

/**
 * BOOK-70 — one state print per surface, in the form its text asks for.
 *
 * The panel used to print the state twice more than it needed: once as a `.filing-state`, the
 * application as a `.filing-fact`, and again as «состояние: …». The middle one is a fact and
 * stays; the state is a chip when it fits one (≤ 24 characters, no clause), and a sentence
 * (14 px, the book's voice, may wrap) when it is a receipt or a clause — a clause cut to one
 * line at 320 px either overflows the panel or lies about its length.
 */

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K5A4Q7',
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 0, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    ...overrides,
  };
}

function render(row: CommentDto): string {
  return renderToStaticMarkup(<FilingPanel comment={row} anchor={null} onClose={() => undefined} />);
}

describe('the filing panel’s state line (BOOK-70)', () => {
  it('prints a chip state once, and no «состояние: …» line at all', () => {
    const html = render(comment());
    expect(html).toContain('<p class="filing-state ink-quiet">ждёт рассмотрения</p>');
    expect(html).not.toContain('состояние:');
    expect(html).not.toContain('filing-word');
    // One state print: the chip, and the application fact beside it.
    expect(html.match(/ждёт рассмотрения/gu)).toHaveLength(1);
  });

  it('keeps the two inks: live while a filing is in work, ink-3 when it is settled', () => {
    const live = render(comment({ status: 'batched' }));
    expect(live).toContain('<p class="filing-state ink-live">в проходе триажа</p>');
    for (const status of ['rejected', 'quarantined', 'hidden'] as const) {
      const settled = render(comment({ status }));
      expect(settled, status).toContain('filing-state ink-quiet');
      expect(settled, status).not.toMatch(/ink-(done|stopped)/u);
    }
  });

  it('prints a clause as a sentence, not as a chip that overflows (BOOK-70)', () => {
    // Each of these is over the 24-character cap, or carries a clause's punctuation.
    for (const status of ['accepted', 'superseded', 'expired'] as const) {
      const row = comment({ status, changeId: 'chg_1' });
      const line = commentStatusLine(row);
      expect(line.form, status).toBe('sentence');
      const html = render(row);
      expect(html, status).toContain(`<p class="filing-sentence">${line.state}</p>`);
      expect(html, status).not.toContain('class="filing-state');
      expect(html, status).not.toContain('состояние:');
    }
  });

  it('prints an applied filing as a receipt, in the sentence’s own voice', () => {
    const html = render(comment({ status: 'applied', applied: { chapter: 7, rev: 2 }, reason: null }));
    expect(html).toContain('<p class="filing-sentence">внесено в главу 07 · право на ваш текст перешло автору книги</p>');
    expect(html).not.toContain('class="filing-state');
    expect(html).not.toContain('состояние:');
  });

  it('keeps a bare «внесено» a chip: without the record of the chapter there is no receipt', () => {
    const html = render(comment({ status: 'applied', applied: null, reason: null }));
    expect(html).toContain('<p class="filing-state ink-quiet">внесено</p>');
    expect(html).not.toContain('filing-sentence');
  });

  it('prints a premise that entered the first edition as a sentence: it names two things', () => {
    const line = commentStatusLine(comment({ premise: true, status: 'applied', chapter: 12, applied: { chapter: 12, rev: 1 } }));
    expect(line).toEqual({ state: 'вошло в первую редакцию главы 12', detail: null, tone: 'done', form: 'sentence' });
    expect(render(comment({ premise: true, status: 'applied', chapter: 12, applied: { chapter: 12, rev: 1 } }))).toContain(
      '<p class="filing-sentence">вошло в первую редакцию главы 12</p>',
    );
  });
});
