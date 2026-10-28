import { AUTHOR_COLORS, FAILED_ATTEMPT_LINE, type CommentDto } from '@book/shared';
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
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-25T12:04:11Z',
    decidedAt: null,
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

describe('the filing panel’s state line (BOOK-90)', () => {
  it('prints a chip state once, and no «состояние: …» line at all', () => {
    const html = render(comment());
    expect(html).toContain('<p class="filing-state ink-quiet">ждёт</p>');
    expect(html).not.toContain('состояние:');
    expect(html).not.toContain('filing-word');
    expect(html.match(/ждёт/gu)).toHaveLength(1);
  });

  it('keeps the two inks: live while a filing is in work, ink-3 when it is settled', () => {
    const live = render(comment({ status: 'batched' }));
    expect(live).toContain('<p class="filing-state ink-live">идёт</p>');
    for (const status of ['rejected', 'quarantined', 'hidden'] as const) {
      const settled = render(comment({ status }));
      expect(settled, status).toContain('filing-state ink-quiet');
      expect(settled, status).not.toMatch(/ink-(done|stopped)/u);
    }
  });

  it('keeps the clause in the detail, where it may wrap, and the state a chip', () => {
    // BOOK-90: the state is one of the three words; the fact it cannot carry is the detail.
    const superseded = render(comment({ status: 'superseded' }));
    expect(superseded).toContain('<p class="filing-state ink-quiet">ждёт</p>');
    expect(superseded).toContain('<p class="filing-fact">снято: текст успел измениться</p>');
    const accepted = render(comment({ status: 'accepted', interventionKind: 'testimony' }));
    expect(accepted).toContain('<p class="filing-state ink-live">идёт</p>');
    expect(accepted).toContain('<p class="filing-fact">правка в очереди на запись</p>');
    const expired = render(comment({ status: 'expired' }));
    expect(expired).toContain('<p class="filing-fact">проход не состоялся</p>');
    for (const html of [superseded, accepted, expired]) {
      expect(html).not.toContain('class="filing-sentence');
      expect(html).not.toContain('состояние:');
    }
  });

  it('prints a landed intervention as the word and its receipt as the fact', () => {
    const html = render(
      comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 7, rev: 2 }, reason: null }),
    );
    expect(html).toContain('<p class="filing-state ink-quiet">внесено</p>');
    expect(html).toContain(
      '<p class="filing-fact">внесено в главу 07 · право на ваш текст перешло автору книги · ревизия 2</p>',
    );
  });

  it('names the record’s numeral beside «внесено» once a change has landed (BOOK-117 §1)', () => {
    // The live path: the chapter's revision carried `cause.changeId`, the filing refreshed to
    // `applied`. The numeral and the word are one surface — the head names the record, the
    // state names the fact — so the reader can tie «внесено» to the entry they filed.
    const html = render(comment({ status: 'applied', interventionKind: 'testimony', applied: { chapter: 8, rev: 2 } }));
    expect(html).toContain('<span class="filing-title">замечание №4Q7</span>');
    expect(html).toContain('<p class="filing-state ink-quiet">внесено</p>');
  });

  it('keeps a bare «внесено» a chip: a note’s terminal is «сохранено», never a right transfer', () => {
    const html = render(comment({ status: 'applied', applied: null, reason: null }));
    expect(html).toContain('<p class="filing-state ink-quiet">внесено</p>');
    expect(html).toContain('<p class="filing-fact">замечание сохранено</p>');
    expect(html).not.toContain('filing-sentence');
  });

  it('prints a premise that entered the first edition as the word and the edition as the fact', () => {
    const line = commentStatusLine(comment({ premise: true, status: 'applied', chapter: 12, applied: { chapter: 12, rev: 1 } }));
    expect(line).toEqual({ state: 'внесено', detail: 'вошло в первую редакцию главы 12', tone: 'done', form: 'chip' });
    const html = render(comment({ premise: true, status: 'applied', chapter: 12, applied: { chapter: 12, rev: 1 } }));
    expect(html).toContain('<p class="filing-state ink-quiet">внесено</p>');
    expect(html).toContain('<p class="filing-fact">вошло в первую редакцию главы 12</p>');
  });

  it('prints the human sentence of a failed attempt on a premise that still waits (BOOK-136)', () => {
    // The measured card: «ждёт» and the derived reading, but the deck's one sentence about the
    // attempt was swallowed by that reading. Both are facts; the sentence goes first.
    const row = comment({ premise: true, status: 'new', chapter: 65, attempt: 'failed', interventionKind: 'document' });
    const html = renderToStaticMarkup(
      <FilingPanel
        comment={row}
        anchor={null}
        onClose={() => undefined}
        premiseIntent="смена переходит на ночь, а не на утро"
      />,
    );
    expect(html).toContain('<p class="filing-state ink-live">ждёт</p>');
    expect(html).toContain(FAILED_ATTEMPT_LINE);
    expect(html).toContain('принято в основу: смена переходит на ночь, а не на утро');
    expect(html).not.toMatch(/PROVIDER_SHAPE|ENGINE_TIMEOUT/u);
    // The same card without the loaded change still says it: the line is the deck's.
    expect(render(row)).toContain(FAILED_ATTEMPT_LINE);
  });
});

/**
 * BOOK-84 — the card the duplicate door opens wears the word the strip above the form says.
 *
 * A premise is not a remark to text that does not exist yet: its card used to be titled
 * «замечание №4Q7» in the visible head and in the accessible name — the exact two places a
 * screen reader and a reader hear the card named. A filing on real text keeps its own word.
 */
describe('what the card calls the filing (BOOK-84)', () => {
  it('calls a premise a «замысел» in its title and its accessible name', () => {
    const html = render(comment({ premise: true, chapter: 9 }));
    expect(html).toContain('<span class="filing-title">замысел №4Q7</span>');
    expect(html).toContain('aria-label="замысел №4Q7"');
    expect(html).not.toMatch(/замечание №4Q7/iu);
  });

  it('keeps «замечание» for a filing on the text', () => {
    const html = render(comment());
    expect(html).toContain('<span class="filing-title">замечание №4Q7</span>');
    expect(html).toContain('aria-label="замечание №4Q7"');
  });
});
