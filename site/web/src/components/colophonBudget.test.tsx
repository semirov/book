/**
 * The money bound in the colophon (BOOK-117), split from `colophon.test.tsx` so both files stay
 * under the architecture gate's 500 lines. The sentences are the server's own
 * (`server/src/budget.ts`), spelled out here on purpose: the page never composes money, so a test
 * that compared a shared constant would only prove the constant agrees with itself.
 */

import {
  IMPRINT_AUTHOR,
  IMPRINT_COPYRIGHT,
  type BudgetDto,
  type StateSnapshot,
} from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Colophon } from './Colophon.tsx';
import { stubDocument, state } from './colophon.fixture.ts';

/** The imprint row's own text, as a reader sees it (React SSR's `<!-- -->` removed). */
function imprintText(html: string): string {
  const match = /<span class="imprint-line">([\s\S]*?)<\/span>/u.exec(html);
  if (match === null) throw new Error('the colophon has no .imprint-line span');
  return (match[1] ?? '').replace(/<!--[\s\S]*?-->/gu, '').replace(/<[^>]*>/gu, '').replace(/\s+/gu, ' ').trim();
}

/**
 * BOOK-117 — the money bound is a fact the colophon states, and these sentences are the
 * server's own (`server/src/budget.ts`), spelled out here on purpose: the page never composes
 * money, so a test that compared against a shared constant would only prove the constant agrees
 * with itself.
 */
const PAUSE_LINE = 'пауза · дневной потолок 10,00 $ · возобновится в 00:00 UTC';
const STOP_LINE = 'остановлено · потолок книги 100,00 $';
const WARN_DAY_LINE = 'дневной потолок 10,00 $ израсходован на 82 %';

/** The server's `BudgetDto`; only the two fields the colophon reads vary per test. */
function budgetOf(state: BudgetDto['state'], line: string): BudgetDto {
  return {
    state,
    line,
    day: {
      spentUsd: state === 'ok' ? 0 : 10,
      capUsd: 10,
      ratio: state === 'ok' ? 0 : 1,
      day: '2026-10-27',
      resumesAt: '2026-10-28T00:00:00.000Z',
    },
    book: { spentUsd: 10, capUsd: 100, ratio: 0.1 },
    tokens: { today: 0 },
  };
}

/** The page as the server sends it: the same empty book, plus the money answer. */
function renderColophonWith(budget: BudgetDto): string {
  stubDocument();
  return renderToStaticMarkup(
    <Colophon
      state={{ ...state, budget } as unknown as StateSnapshot}
      imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }}
    />,
  );
}

/**
 * The money row: its attribute string, its one child and where the row itself ends. Throws when
 * the row is absent, so a missing pause fails here instead of passing an empty comparison.
 */
function budgetRow(html: string): { attrs: string; body: string; end: number } {
  const match = /<div class="row"([^>]*data-budget-state="[^"]*"[^>]*)>([\s\S]*?)<\/div>/u.exec(html);
  if (match === null) throw new Error('the colophon has no money row');
  return {
    attrs: match[1] ?? '',
    body: match[2] ?? '',
    end: (match.index ?? 0) + match[0].length,
  };
}

/** Where the imprint row begins: the last plain `.row` before the pinned sentence's own span. */
function imprintRowStart(html: string): number {
  const span = html.indexOf('<span class="imprint-line">');
  if (span < 0) throw new Error('the colophon has no .imprint-line span');
  return html.lastIndexOf('<div class="row">', span);
}

describe('the money bound in the colophon (BOOK-117)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The owner's instruction: «приостановка, если в день потратили более 10 баксов» must be
  // visible on the page itself — one row of the marks register, the server's sentence verbatim.
  it('prints the pause line verbatim, in the marks register, directly above the imprint row', () => {
    const html = renderColophonWith(budgetOf('pause', PAUSE_LINE));
    const row = budgetRow(html);
    expect(row.attrs).toContain('data-budget-state="pause"');
    // The server's sentence, in `mono`, and nothing beside it in the row.
    expect(row.body).toBe(`<span class="mono">${PAUSE_LINE}</span>`);
    // An accessible name that repeats the state word; a fact, not a control.
    expect(row.attrs).toContain('role="note"');
    expect(row.attrs).toContain(`aria-label="${PAUSE_LINE}"`);
    expect(row.attrs).not.toMatch(/title=|href=|tabindex|onclick/u);
    expect(row.body).not.toContain('<a');
    expect(row.body).not.toContain('<button');
    // No exclamation, no cheer, no emoji: it reads as a ledger fact.
    expect(row.body).not.toContain('!');
    expect(row.body).not.toMatch(/\p{Extended_Pictographic}/u);
    // One row, one print.
    expect(html.match(/data-budget-state=/gu)).toHaveLength(1);
    // Adjacent: the money row's closing tag meets the imprint row's opening tag.
    expect(row.end).toBe(imprintRowStart(html));
    // And the sentence BOOK-94 pins is untouched by the new row.
    expect(imprintText(html)).toBe(
      '© Филипп Семиров — С любовью к научной фантастике и современным технологиям · приватность · правила',
    );
  });

  it('prints the stop line verbatim, and marks the row as a stop', () => {
    const html = renderColophonWith(budgetOf('stop', STOP_LINE));
    const row = budgetRow(html);
    expect(row.attrs).toContain('data-budget-state="stop"');
    expect(row.body).toBe(`<span class="mono">${STOP_LINE}</span>`);
    expect(row.attrs).toContain(`aria-label="${STOP_LINE}"`);
    expect(html.match(/data-budget-state=/gu)).toHaveLength(1);
    expect(row.end).toBe(imprintRowStart(html));
  });

  it('prints the warn line the server composed, not a line of its own', () => {
    const html = renderColophonWith(budgetOf('warn', WARN_DAY_LINE));
    const row = budgetRow(html);
    expect(row.attrs).toContain('data-budget-state="warn"');
    expect(row.body).toBe(`<span class="mono">${WARN_DAY_LINE}</span>`);
    // The percentage is the server's: the page prints it, it does not compute it.
    expect(row.body).not.toContain('$ израсходован на 83');
    expect(row.end).toBe(imprintRowStart(html));
  });

  // `ok` and a snapshot that predates the field render the colophon exactly as it was: the row is
  // a statement about a bound that is not being approached, so there is nothing to print.
  it('prints no money row for `ok`, and stays byte-identical to a snapshot without the field', () => {
    stubDocument();
    const absent = renderToStaticMarkup(
      <Colophon state={state} imprint={{ author: IMPRINT_AUTHOR, copyright: IMPRINT_COPYRIGHT }} />,
    );
    const ok = renderColophonWith(budgetOf('ok', ''));
    expect(ok).toBe(absent);
    expect(absent).not.toContain('data-budget-state');
    expect(ok).not.toContain('data-budget-state');
    // The rest of the colophon is character-identical: the sentence and the register rows.
    expect(imprintText(absent)).toBe(
      '© Филипп Семиров — С любовью к научной фантастике и современным технологиям · приватность · правила',
    );
    expect(imprintText(ok)).toBe(imprintText(absent));
    expect(ok).toContain('печатается по ходу письма');
    expect(ok).toContain('книга · глав ещё нет');
  });
});
