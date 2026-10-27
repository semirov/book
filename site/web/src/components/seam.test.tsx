import type { CatalogEntry, CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EMPTY_COMPOSER } from '../lib/composer.ts';
import { filingsForBlock } from '../lib/filings.ts';
import { premiseRow } from '../lib/premise.ts';
import { anchorFor } from '../lib/seam.ts';
import { FilingMark } from './FilingMark.tsx';
import { PremiseRow } from './PremiseRow.tsx';
import { Seam } from './Seam.tsx';

/** BOOK-DOC-34 — the surfaces a reader meets at the seam, without a browser. */

function entry(n: number, overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    n,
    part: 1,
    title: 'Тестовая глава',
    rev: 3,
    chars: 22_000,
    blocks: 40,
    written: true,
    basis: false,
    writtenAt: '2026-10-25T09:20:00Z',
    updatedAt: '2026-10-25T09:20:00Z',
    direction: 'forward',
    ...overrides,
  };
}

const TEXT = 'Я вошёл в пустую комнату. Её освещал яркий свет.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 1, quote: 'Её освещал яркий свет.', prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'new',
    premise: false,
    reason: null,
    createdAt: '2026-10-21T12:03:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

const FILINGS = filingsForBlock([comment()], 'ch08#aa11bb22');

function strip(overrides: { frozen?: boolean; premise?: boolean; signedIn?: boolean; withFilings?: boolean } = {}): string {
  const anchor = overrides.premise === true ? null : anchorFor({ text: TEXT, blockId: 'ch08#aa11bb22', baseRev: 3, offset: 2 });
  return renderToStaticMarkup(
    <Seam
      entry={entry(overrides.frozen === true ? 1 : 8, { basis: overrides.frozen === true })}
      draftKey="ch8:test"
      anchor={anchor}
      frozen={overrides.frozen === true}
      filings={overrides.withFilings === true ? (FILINGS[0] ?? null) : null}
      composer={EMPTY_COMPOSER}
      viewer={{ signedIn: overrides.signedIn ?? true, displayName: 'Филипп' }}
      onPosted={() => undefined}
      onClose={() => undefined}
      onProvenance={() => undefined}
      onOpenFiling={() => undefined}
    />,
  );
}

describe('the strip at the seam', () => {
  it('carries the tapped word, the provenance button and one action', () => {
    const html = strip();
    expect(html).toContain('«вошёл»');
    expect(html).toContain('откуда это слово');
    expect(html).toContain('вмешаться');
    expect(html).toContain('aria-label="место вмешательства · глава 08"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="закрыть место вмешательства"');
    // The form is not in the markup until the strip is asked to grow.
    expect(html).not.toContain('seam-submit');
  });

  it('offers sign-in instead of the form to a reader who is not signed in', () => {
    const html = strip({ signedIn: false });
    expect(html).toContain('войти через Яндекс');
    expect(html).not.toContain('вмешаться</button>');
  });

  it('has no form on a frozen chapter, ever — and says why', () => {
    const html = strip({ frozen: true });
    expect(html).toContain('закреплено');
    expect(html).toContain('рамка книги →');
    expect(html).toContain('/rules#рамка');
    expect(html).not.toContain('вмешаться');
    expect(html).not.toContain('войти через Яндекс');
  });

  it('takes a premise in an empty chapter, with the honest line about what it is', () => {
    const html = strip({ premise: true });
    expect(html).toContain('«главы ещё нет»');
    expect(html).toContain('заложить замысел');
    expect(html).toContain('станет первой редакцией');
    expect(html).not.toContain('откуда это слово');
  });

  it('lists a filing in the strip as a row whose state word is printed and kept in the label (BOOK-70, BOOK-111)', () => {
    const html = strip({ withFilings: true });
    expect(html).toContain('№4Q7');
    expect(html).toContain('Аня');
    // BOOK-111 (owner, 2026-10-27): a filing that exists must say it waits — the word is
    // visible on the row; the button's label still names the whole row for a screen reader.
    expect(html).toContain('<span class="seam-filing-word">ждёт</span>');
    expect(html).toContain('aria-label="замечание №4Q7 · ждёт · «Её освещал яркий свет.»"');
    expect(html).toContain('Её освещал яркий свет.');
  });

  it('never says «шов» and never puts a style attribute in the markup', () => {
    const html = [strip(), strip({ frozen: true }), strip({ premise: true })].join('\n');
    expect(html.toLowerCase()).not.toContain('шов');
    expect(html).not.toMatch(/style=/u);
  });
});

describe('the mark on a sentence', () => {
  it('prints the record numeral and the overflow as a real button', () => {
    const filings = FILINGS[0];
    const html = renderToStaticMarkup(
      <FilingMark filings={filings!} onOpen={() => undefined} onOpenRevision={() => undefined} />,
    );
    // The numeral is the button: what the reader sees is what the reader taps.
    expect(html).toMatch(/<button[^>]*class="filing-mark filing-alive[^"]*"[^>]*>\s*<span class="filing-mark-num">№4Q7/u);
    expect(html).toContain('aria-label="замечание №4Q7 · ждёт"');
    expect(html).not.toContain('style=');
  });

  it('keeps the numeral inside the 24 px target and names the overflow in the label', () => {
    const second = comment({ id: 'cmt_01J9Z8K5AA', createdAt: '2026-10-22T09:00:00Z' });
    const [group] = filingsForBlock([comment(), second], 'ch08#aa11bb22');
    const html = renderToStaticMarkup(
      <FilingMark filings={group!} onOpen={() => undefined} onOpenRevision={() => undefined} />,
    );
    // BOOK-33: a «+N» glyph would widen the mark past its box; the count lives in the label
    // (and the strip's «ещё N →») instead of pushing the numeral out of the target.
    expect(html).not.toContain('+1');
    expect(html).toContain('ещё 1');
  });
});

describe('the empty slot row', () => {
  it('is a dotted field with the number and no word, not a call to action', () => {
    const row = premiseRow(entry(7, { written: false, title: null }), null);
    const html = renderToStaticMarkup(<PremiseRow row={row!} onOpen={() => undefined} />);
    expect(html).toContain('class="premise-row"');
    expect(html).toContain('07');
    // BOOK-112: the row is the number and the field — no state word, no explanation.
    expect(html).not.toContain('замысел');
    expect(html).not.toContain('class="premise-label"');
    expect(html).not.toContain('style=');
    expect(html).not.toContain('Глава');
  });

  it('shows the premise a chapter already holds, with its own words and its state word', () => {
    const premise = comment({ id: 'cmt_3', chapter: 7, premise: true, status: 'accepted', anchor: { ...comment().anchor, blockId: null, quote: null } });
    const row = premiseRow(entry(7, { written: false, title: null }), premise);
    const html = renderToStaticMarkup(<PremiseRow row={row!} onOpen={() => undefined} />);
    expect(html).toContain('«в комнате должен быть свет, но не от лампы»');
    // BOOK-111 (owner, 2026-10-27): a held premise says it waits — one word, after the field.
    expect(html).toContain('<span class="premise-label">ждёт</span>');
    // And the word is part of what the row names itself: `aria-label` would otherwise hide it.
    expect(html).toContain('aria-label="глава 7 · ждёт"');
    expect(html).not.toContain('замысел');
  });
});
