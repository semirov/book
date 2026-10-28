import type { CommentDto, DispositionReport, MyDecisionDto } from '@book/shared';
import { AUTHOR_COLORS } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decisionLine } from '../lib/ownDecisions.ts';
import { DispositionLines } from './DispositionLines.tsx';
import { FilingPanel } from './FilingPanel.tsx';

/**
 * BOOK-174 — the report is a record, not a toast.
 *
 * Three lines, on the filing's own card and on the reader's own list, and they are the ones the
 * server derived from the stored chain — line 1 the reading, line 2 why, line 3 where it stands
 * in the book. A filing read before v27 has no report at all, and the card prints nothing for it.
 */

const REPORT: DispositionReport = {
  line1: 'прочитано через бумагу, а не как сказано',
  line2: 'потому что в сцене это некому сказать, а в регистратуре есть кому',
  line3: 'где это в книге: глава 12 · абзац 9 · предложение 1 — документ',
};

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K5A4Q7',
    chapter: 12,
    anchor: { blockId: 'ch12#aa11bb22', blockIndex: 8, quote: 'Он вошёл в регистратуру.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'В сцене этого некому сказать.',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'accepted',
    frame: 'untouched',
    reason: 'принято',
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: '2026-10-25T12:30:00Z',
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

function render(row: CommentDto): string {
  return renderToStaticMarkup(<FilingPanel comment={row} anchor={null} onClose={() => undefined} />);
}

describe('the filing card prints the reading (BOOK-174)', () => {
  it('renders the three lines as three paragraphs, the first heading the block', () => {
    const html = render(comment({ disposition: 'through_paper', report: REPORT }));
    expect(html).toContain('filing-resolution');
    expect(html).toContain(`<p class="filing-resolution-head">${REPORT.line1}</p>`);
    expect(html).toContain(`<p class="filing-resolution-why">${REPORT.line2}</p>`);
    expect(html).toContain(`<p class="filing-resolution-place">${REPORT.line3}</p>`);
    // No label of its own: the words are the server's, the block adds none.
    expect(html).not.toContain('прочитано:');
    expect(html).not.toContain('состояние:');
  });

  it('carries the real anchor: chapter, paragraph and sentence, all 1-based', () => {
    const html = render(comment({ disposition: 'as_said', report: { ...REPORT, line3: 'где это в книге: глава 12 · абзац 9 · предложение 1' } }));
    expect(html).toContain('глава 12 · абзац 9 · предложение 1');
  });

  it('prints nothing for a filing read before the report existed', () => {
    const html = render(comment());
    expect(html).not.toContain('filing-resolution');
  });

  it('prints a refusal as its own two lines: what did not happen, and what works instead', () => {
    const html = render(
      comment({
        status: 'rejected',
        refusal: 'rights',
        disposition: 'inadmissible',
        report: {
          line1: 'не принято',
          line2: 'потому что это не ваш текст',
          line3: 'сработает иначе: перескажите своими в пяти словах',
        },
      }),
    );
    expect(html).toContain('<p class="filing-resolution-head">не принято</p>');
    expect(html).toContain('сработает иначе: перескажите своими в пяти словах');
  });
});

describe('the report component itself', () => {
  it('is three paragraphs and nothing else', () => {
    const html = renderToStaticMarkup(<DispositionLines report={REPORT} />);
    expect(html.match(/<p /gu)).toHaveLength(3);
    expect(html.match(/<section /gu)).toHaveLength(1);
  });
});

describe('the reader’s own record prints the reading too (BOOK-174)', () => {
  function decision(overrides: Partial<MyDecisionDto> = {}): MyDecisionDto {
    return {
      commentId: 'cmt_A',
      changeId: null,
      chapter: 12,
      premise: false,
      intent: null,
      outcome: 'escalated',
      reason: 'можно ли оформить это бумагой?',
      chapters: [],
      waves: null,
      blocks: null,
      shareAtDecision: null,
      decidedAt: '2026-10-25T12:30:00Z',
      ...overrides,
    };
  }

  it('keeps the escalated wording, and adds the reading’s own clause', () => {
    const line = decisionLine(
      decision({
        report: {
          line1: 'ждёт решения автора',
          line2: 'потому что эта правка меняет не слово, а исход',
          line3: 'решает автор',
        },
      }),
      0,
    );
    expect(line.text).toContain('правка остановлена · ждёт решения автора');
    // The reading's clause is the fact the state word cannot carry; line 1 is not repeated.
    expect(line.text).toContain('потому что эта правка меняет не слово, а исход');
    expect(line.text.match(/ждёт решения автора/gu)).toHaveLength(1);
    expect(line.tone).toBe('live');
  });

  it('adds the reading to a landed filing without replacing its summary', () => {
    const line = decisionLine(
      decision({
        changeId: 'chg_A',
        outcome: 'applied',
        intent: 'внести документ',
        chapters: [12],
        waves: 1,
        blocks: 2,
        shareAtDecision: { share: 0.004, day: '2026-10-25' },
        report: {
          line1: 'прочитано через бумагу',
          line2: 'потому что в сцене это некому сказать, а в регистратуре есть кому',
          line3: 'где это в книге: глава 12 · абзац 9 · предложение 1 — документ',
        },
      }),
      0.004,
    );
    expect(line.text).toContain('правка внесена');
    expect(line.text).toContain('прочитано через бумагу');
    expect(line.text).toContain('потому что в сцене это некому сказать, а в регистратуре есть кому');
  });
});
