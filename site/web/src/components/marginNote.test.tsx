import type { CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { STATE_WORDS } from '../lib/marginalia.ts';
import { FilingCard } from './FilingCard.tsx';
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
  it('carries the state word, the quote, the kind, the author and the next line — never a number', () => {
    const html = renderToStaticMarkup(<MarginNote comment={comment()} onOpen={noop} />);
    expect(html).toContain('class="margin-note');
    expect(html).toContain('data-margin-item="note"');
    // §11.3 — the filing's number is the mark's, printed once: the note never repeats it.
    expect(html).not.toContain('№4Q7');
    expect(html).not.toContain('data-number');
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

  it('prints the group’s count only when there really are several', () => {
    expect(renderToStaticMarkup(<MarginNote comment={comment()} onOpen={noop} />)).not.toContain('ещё');
    const html = renderToStaticMarkup(<MarginNote comment={comment()} extra={2} onOpen={noop} />);
    expect(html).toContain('data-extra="2"');
    expect(html).toContain('margin-note-more">ещё 2');
  });

  it('keeps every held, rejected and expired filing alive in the margin', () => {
    for (const status of ['quarantined', 'rejected', 'expired', 'superseded', 'batched', 'accepted'] as const) {
      const html = renderToStaticMarkup(<MarginNote comment={comment({ status })} onOpen={noop} />);
      expect(html, status).toContain('class="margin-note');
    }
  });
});

describe('the phone strip (<1024)', () => {
  it('lists a row per alive filing with the change’s number, the kind and the state word', () => {
    const html = renderToStaticMarkup(
      <PhoneStrip comments={[comment({ changeSeq: 12 })]} skipQuote={null} onOpen={noop} />,
    );
    expect(html).toContain('class="phone-strip');
    expect(html).toContain('phone-strip-row');
    expect(html).toContain('>012<');
    expect(html).not.toContain('№4Q7');
    expect(html).toContain('свидетельство');
    expect(html).toContain('ждёт');
    expect(html).toContain('→');
    // No count, no badge: the strip is rows, not a summary.
    expect(html).not.toContain('замечани');
  });

  it('starts a row with no number at its kind, never a dangling separator', () => {
    const html = renderToStaticMarkup(<PhoneStrip comments={[comment()]} skipQuote={null} onOpen={noop} />);
    expect(html).toContain('>свидетельство<');
    expect(html).not.toContain('phone-strip-n');
    expect(html.replace(/<[^>]+>/gu, '')).not.toMatch(/^·/u);
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
  it('shows the change’s own number for an alive filing, never a token', () => {
    const [group] = filingsForBlock([comment({ changeSeq: 12 })], 'ch08#aa11bb22');
    const html = renderToStaticMarkup(
      <FilingMark filings={group!} onOpen={noop} />,
    );
    expect(html).toContain('filing-alive');
    expect(html).toContain('class="filing-mark-num"');
    expect(html).toContain('>012<');
    expect(html).toContain('data-number="правка 012"');
    expect(html).toContain('aria-label="правка 012 · ждёт"');
    expect(html).not.toContain('№');
  });

  it('carries the group’s count, and a filing with no change number is a tick', () => {
    const [many] = filingsForBlock(
      [comment({ id: 'cmt_1', changeSeq: 12 }), comment({ id: 'cmt_2', changeSeq: 13, status: 'batched' })],
      'ch08#aa11bb22',
    );
    const html = renderToStaticMarkup(<FilingMark filings={many!} onOpen={noop} />);
    expect(html).toContain('data-extra="1"');
    expect(html).toContain('ещё 1');
    // An ordinal no row carries is never cut out of an id: the mark is the honest tick.
    const [bare] = filingsForBlock([comment()], 'ch08#aa11bb22');
    const tick = renderToStaticMarkup(<FilingMark filings={bare!} onOpen={noop} />);
    expect(tick).toContain('filing-bare');
    expect(tick).toContain('filing-tick-bar');
    expect(tick).not.toContain('filing-mark-num');
    expect(tick).not.toContain('№');
  });

  it('shows a single tick for a landed change: no visible words, the fact in the label', () => {
    const [group] = filingsForBlock(
      [comment({ status: 'applied', applied: { chapter: 8, rev: 4 } })],
      'ch08#aa11bb22',
    );
    const html = renderToStaticMarkup(
      <FilingMark filings={group!} onOpen={noop} />,
    );
    expect(html).toContain('filing-tick');
    expect(html).toContain('filing-tick-bar');
    expect(html).not.toContain('filing-mark-num');
    expect(html).toContain('aria-label="внесено · открыть запись правка"');
    // The tick carries no visible text at all.
    expect(html.replace(/<[^>]+>/gu, '').trim()).toBe('');
  });

  it('lets the alive filing win the slot over a landed one', () => {
    const texts = filingsForBlock(
      [
        comment({ id: 'cmt_01J9Z8K4Q7', status: 'applied', applied: { chapter: 8, rev: 4 } }),
        comment({ id: 'cmt_01J9Z8K5AA', status: 'new', changeSeq: 12 }),
      ],
      'ch08#aa11bb22',
    );
    const html = renderToStaticMarkup(
      <FilingMark filings={texts[0]!} onOpen={noop} />,
    );
    expect(html).toContain('filing-alive');
    expect(html).toContain('>012<');
    expect(html).not.toContain('filing-tick');
  });

  it('prints nothing for a hidden filing', () => {
    const [group] = filingsForBlock([comment({ status: 'hidden' })], 'ch08#aa11bb22');
    expect(renderToStaticMarkup(<FilingMark filings={group!} onOpen={noop} />)).toBe('');
  });
});

describe('AC4 — one vocabulary, three surfaces', () => {
  // BOOK-189: `accepted` is not a word of its own — it waits until its change is in hand — and
  // a refusal is «отклонено», never «ждёт».
  const table: Array<[CommentDto['status'], string]> = [
    ['new', STATE_WORDS.waiting],
    ['batched', STATE_WORDS.working],
    ['delivered', STATE_WORDS.working],
    ['accepted', STATE_WORDS.waiting],
    ['applied', STATE_WORDS.landed],
    ['superseded', STATE_WORDS.waiting],
    ['rejected', STATE_WORDS.refused],
    ['quarantined', STATE_WORDS.waiting],
    ['expired', STATE_WORDS.waiting],
    ['hidden', STATE_WORDS.waiting],
  ];

  it('prints the same word from the note, the strip and the record entry, status by status', () => {
    for (const [status, word] of table) {
      const row = comment({ status });
      const note = renderToStaticMarkup(<MarginNote comment={row} onOpen={noop} />);
      const strip = renderToStaticMarkup(<PhoneStrip comments={[row]} skipQuote={null} onOpen={noop} />);
      const record = renderToStaticMarkup(<FilingCard comment={row} onClose={noop} />);
      expect(note, `note ${status}`).toContain(`>${word}<`);
      expect(strip, `strip ${status}`).toContain(`>${word}<`);
      expect(record, `record ${status}`).toContain(`>${word}<`);
    }
  });

  it('prints «идёт» on an accepted filing only while the writer is at it', () => {
    const working = comment({ status: 'accepted', changeStatus: 'processing' });
    for (const html of [
      renderToStaticMarkup(<MarginNote comment={working} onOpen={noop} />),
      renderToStaticMarkup(<PhoneStrip comments={[working]} skipQuote={null} onOpen={noop} />),
      renderToStaticMarkup(<FilingCard comment={working} onClose={noop} />),
    ]) {
      expect(html).toContain(`>${STATE_WORDS.working}<`);
    }
  });

  it('says a gate’s word once, and a landing’s receipt once (BOOK-189)', () => {
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    // B stores its own word in front of the rule's sentence; the row heads the line with it, so
    // the word appears once and the sentence keeps standing after it.
    const refused = comment({
      status: 'rejected',
      refusal: 'rights',
      reason: 'не принято: пересказ чужого текста без источника',
    });
    const refusedNote = renderToStaticMarkup(<MarginNote comment={refused} onOpen={noop} />);
    const refusedStrip = renderToStaticMarkup(<PhoneStrip comments={[refused]} skipQuote={null} onOpen={noop} />);
    const refusedPanel = renderToStaticMarkup(<FilingCard comment={refused} onClose={noop} />);
    for (const html of [refusedNote, refusedStrip, refusedPanel]) expect(count(html, 'не принято')).toBe(1);
    // The strip is a word and a door; the note and the card own the sentence beside the word.
    for (const html of [refusedNote, refusedPanel]) {
      expect(html).toContain('пересказ чужого текста без источника');
    }

    // A landed filing: one «внесено» (the word), then the word-free receipt of every surface.
    const landed = comment({ status: 'applied', applied: { chapter: 7, rev: 4 } });
    const landedNote = renderToStaticMarkup(<MarginNote comment={landed} onOpen={noop} />);
    const landedStrip = renderToStaticMarkup(<PhoneStrip comments={[landed]} skipQuote={null} onOpen={noop} />);
    const landedPanel = renderToStaticMarkup(<FilingCard comment={landed} onClose={noop} />);
    for (const html of [landedNote, landedStrip, landedPanel]) expect(count(html, 'внесено')).toBe(1);
    // The receipt is the same line on the note and the card; the strip is the word and a door.
    for (const html of [landedNote, landedPanel]) {
      expect(html).toContain('глава 7 · ревизия 4');
      expect(html).not.toContain('право на ваш текст');
    }
  });

  it('has one word per state, and none of them is a phrase', () => {
    // BOOK-137 added «рассмотрено» (a decision about a record) and BOOK-189 «отклонено» (a
    // refusal); BOOK-206 removed the author's word. None is a phrase, and «внесено» stays what
    // the text says.
    expect(Object.values(STATE_WORDS)).toEqual(['ждёт', 'идёт', 'внесено', 'рассмотрено', 'отклонено']);
    for (const wrong of ['ждёт рассмотрения', 'в проходе триажа', 'в основе', 'ждёт очереди', 'фраза не изменилась']) {
      expect(Object.values(STATE_WORDS)).not.toContain(wrong);
    }
  });
});
