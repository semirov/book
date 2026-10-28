import type { CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { STATE_WORDS } from '../lib/marginalia.ts';
import { FilingPanel } from './FilingPanel.tsx';
import { FilingMark } from './FilingMark.tsx';
import { MarginNote } from './MarginNote.tsx';
import { PhoneStrip } from './PhoneStrip.tsx';
import { filingsForBlock } from '../lib/filings.ts';

/**
 * BOOK-90 — the margin note and the phone strip, without a browser.
 *
 * AC1: an alive filing is visible with **no interaction** — the note at ≥1024 and the strip
 * at <1024 are both in the DOM; the width alone decides which one is painted (the CSS
 * contract is asserted in `server/test/marginaliaCss.test.ts`). AC4: one vocabulary — the
 * note, the strip and the record entry print the same word for the same status.
 */

const QUOTE = 'Её освещал яркий свет.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    chapter: 8,
    anchor: { blockId: 'ch08#aa11bb22', blockIndex: 1, quote: QUOTE, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: '#6f9bb5',
    body: 'в комнате должен быть свет, но не от лампы',
    proposedText: 'Свет был включён до меня.',
    interventionKind: 'testimony',
    status: 'new',
    frame: 'untouched',
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

const noop = (): void => undefined;

describe('the margin note (≥1024)', () => {
  it('carries the numeral, the state word, the quote, the kind, the author and the next line', () => {
    const html = renderToStaticMarkup(<MarginNote comment={comment()} onOpen={noop} />);
    expect(html).toContain('class="margin-note');
    expect(html).toContain('data-margin-item="note"');
    expect(html).toContain('data-number="№4Q7"');
    expect(html).toContain('№4Q7');
    expect(html).toContain('ждёт');
    expect(html).toContain('«Её освещал яркий свет.»');
    expect(html).toContain('свидетельство · Аня');
    // The one line a reader must be able to read without a click.
    expect(html).toContain('попадёт в триаж');
    // No timestamp in the margin: the stamp belongs to the opened object.
    expect(html).not.toContain('21.10');
    // No hover-only information: the word is text in the DOM, not a `title` attribute.
    expect(html).not.toContain('title=');
    expect(html).not.toMatch(/style=/u);
  });

  it('prints the kind only when the filing has one, and always the author', () => {
    const note = renderToStaticMarkup(<MarginNote comment={comment({ interventionKind: null })} onOpen={noop} />);
    expect(note).toContain('margin-note-who">Аня');
    expect(note).not.toContain('свидетельство');
  });

  it('keeps every held, rejected and expired filing alive in the margin', () => {
    for (const status of ['quarantined', 'rejected', 'expired', 'superseded', 'batched', 'accepted'] as const) {
      const html = renderToStaticMarkup(<MarginNote comment={comment({ status })} onOpen={noop} />);
      expect(html, status).toContain('class="margin-note');
    }
  });
});

describe('the phone strip (<1024)', () => {
  it('lists a row per alive filing with the numeral, the kind and the state word', () => {
    const html = renderToStaticMarkup(
      <PhoneStrip comments={[comment()]} skipQuote={null} onOpen={noop} />,
    );
    expect(html).toContain('class="phone-strip');
    expect(html).toContain('phone-strip-row');
    expect(html).toContain('№4Q7');
    expect(html).toContain('свидетельство');
    expect(html).toContain('ждёт');
    expect(html).toContain('→');
    // No count, no badge: the strip is rows, not a summary.
    expect(html).not.toContain('замечани');
  });

  it('shows two rows and one quiet door to the rest', () => {
    const rows = [
      comment({ id: 'cmt_1', createdAt: '2026-10-21T12:03:00Z' }),
      comment({ id: 'cmt_2', createdAt: '2026-10-22T12:03:00Z' }),
      comment({ id: 'cmt_3', createdAt: '2026-10-23T12:03:00Z' }),
    ];
    const html = renderToStaticMarkup(<PhoneStrip comments={rows} skipQuote={null} onOpen={noop} />);
    expect(html.match(/phone-strip-row/g) ?? []).toHaveLength(3); // two rows + the door
    expect(html).toContain('ещё 1 →');
    expect(html).not.toContain('без типа');
  });

  it('skips the row of a sentence whose seam is open in this paragraph', () => {
    const html = renderToStaticMarkup(
      <PhoneStrip comments={[comment()]} skipQuote={QUOTE} onOpen={noop} />,
    );
    expect(html).toBe('');
  });

  it('says nothing when nothing is alive', () => {
    expect(renderToStaticMarkup(<PhoneStrip comments={[]} skipQuote={null} onOpen={noop} />)).toBe('');
  });
});

describe('the mark at the sentence', () => {
  it('shows the numeral for an alive filing, with its word in the accessible name', () => {
    const [group] = filingsForBlock([comment()], 'ch08#aa11bb22');
    const html = renderToStaticMarkup(
      <FilingMark filings={group!} onOpen={noop} onOpenRevision={noop} />,
    );
    expect(html).toContain('filing-alive');
    expect(html).toContain('class="filing-mark-num"');
    expect(html).toContain('aria-label="замечание №4Q7 · ждёт"');
  });

  it('shows a single tick for a landed change: no visible words, the fact in the label', () => {
    const [group] = filingsForBlock(
      [comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })],
      'ch08#aa11bb22',
    );
    const html = renderToStaticMarkup(
      <FilingMark filings={group!} onOpen={noop} onOpenRevision={noop} />,
    );
    expect(html).toContain('filing-tick');
    expect(html).toContain('filing-tick-bar');
    expect(html).not.toContain('filing-mark-num');
    expect(html).toContain('aria-label="внесено · открыть запись №4Q7"');
    // The tick carries no visible text at all.
    expect(html.replace(/<[^>]+>/gu, '').trim()).toBe('');
  });

  it('lets the alive filing win the slot over a landed one', () => {
    const texts = filingsForBlock(
      [
        comment({ id: 'cmt_01J9Z8K4Q7', status: 'applied', applied: { chapter: 8, rev: 4 } }),
        comment({ id: 'cmt_01J9Z8K5AA', status: 'new' }),
      ],
      'ch08#aa11bb22',
    );
    const html = renderToStaticMarkup(
      <FilingMark filings={texts[0]!} onOpen={noop} onOpenRevision={noop} />,
    );
    expect(html).toContain('filing-alive');
    expect(html).not.toContain('filing-tick');
  });

  it('prints nothing for a hidden filing', () => {
    const [group] = filingsForBlock([comment({ status: 'hidden' })], 'ch08#aa11bb22');
    expect(renderToStaticMarkup(<FilingMark filings={group!} onOpen={noop} onOpenRevision={noop} />)).toBe('');
  });
});

describe('AC4 — one vocabulary, three surfaces', () => {
  const table: Array<[CommentDto['status'], string]> = [
    ['new', STATE_WORDS.waiting],
    ['batched', STATE_WORDS.working],
    ['delivered', STATE_WORDS.working],
    ['accepted', STATE_WORDS.working],
    ['applied', STATE_WORDS.landed],
    ['superseded', STATE_WORDS.waiting],
    ['rejected', STATE_WORDS.waiting],
    ['quarantined', STATE_WORDS.waiting],
    ['expired', STATE_WORDS.waiting],
    ['hidden', STATE_WORDS.waiting],
  ];

  it('prints the same word from the note, the strip and the record entry, status by status', () => {
    for (const [status, word] of table) {
      const row = comment({ status });
      const note = renderToStaticMarkup(<MarginNote comment={row} onOpen={noop} />);
      const strip = renderToStaticMarkup(<PhoneStrip comments={[row]} skipQuote={null} onOpen={noop} />);
      const record = renderToStaticMarkup(<FilingPanel comment={row} anchor={null} onClose={noop} />);
      expect(note, `note ${status}`).toContain(`>${word}<`);
      expect(strip, `strip ${status}`).toContain(`>${word}<`);
      expect(record, `record ${status}`).toContain(`>${word}<`);
    }
  });

  it('has one word per state, and none of them is a phrase', () => {
    // BOOK-137 added the paperwork state: «рассмотрено» is a decision about a record, and
    // «внесено» stays what the text says — the two are never used for one another.
    expect(Object.values(STATE_WORDS)).toEqual([
      'ждёт',
      'идёт',
      'внесено',
      'рассмотрено',
      // BOOK-174 — the escalated filing's own word; it is a state, not a gate's line.
      'ждёт решения автора',
    ]);
    for (const wrong of ['ждёт рассмотрения', 'в проходе триажа', 'в основе', 'ждёт очереди', 'фраза не изменилась']) {
      expect(Object.values(STATE_WORDS)).not.toContain(wrong);
    }
  });
});
