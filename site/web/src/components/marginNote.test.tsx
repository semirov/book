import type { CommentDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { filingsForBlock } from '../lib/filings.ts';
import { STATE_LINES, STATE_WORDS } from '../lib/marginalia.ts';
import { FilingCard } from './FilingCard.tsx';
import { FilingMark } from './FilingMark.tsx';
import { MarginNote } from './MarginNote.tsx';
import { PhoneStrip } from './PhoneStrip.tsx';

/**
 * BOOK-90 / BOOK-218 — the margin note, the mark and the phone strip, without a browser.
 *
 * AC1: an alive filing is visible with **no interaction** — the note at ≥1024 and the strip
 * at <1024 are both in the DOM; the width alone decides which one is painted (the CSS
 * contract is asserted in `server/test/marginaliaCss.test.ts`).
 *
 * AC4: **one** vocabulary. The note is a pointer now: the number, the quoted phrase and who
 * filed it, never a state word and never a second line — the record states the filing, and the
 * row and the column do not say it again. The state's word still travels on every surface that
 * speaks about the state: the strip, the card, and the mark's accessible name.
 */

const QUOTE = 'Её освещал яркий свет.';

function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K4Q7',
    number: 12,
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
  it('is a pointer: the number, the quote, who filed it — and no state and no next line', () => {
    const html = renderToStaticMarkup(<MarginNote comment={comment()} onOpen={noop} />);
    expect(html).toContain('class="margin-note');
    expect(html).toContain('data-margin-item="note"');
    expect(html).toContain('data-number="12"');
    expect(html).toContain('class="margin-note-n">12<');
    expect(html).toContain('«Её освещал яркий свет.»');
    expect(html).toContain('свидетельство · Аня');
    // BOOK-218 — the record carries the state; the note never says it a second time. Its
    // visible text is a pointer; the word lives in the accessible name alone.
    const visible = html.replace(/<[^>]+>/gu, ' ');
    expect(visible).not.toContain(STATE_WORDS.waiting);
    expect(visible).not.toContain(STATE_LINES.waiting);
    expect(html).not.toContain('margin-note-next');
    // No timestamp in the margin: the stamp belongs to the opened object.
    expect(html).not.toContain('21.10');
    // No hover-only information: the word is text in the DOM, not a `title` attribute.
    expect(html).not.toContain('title=');
    expect(html).not.toMatch(/style=/u);
  });

  it('carries the module’s word in its accessible name, so the state is never colour alone', () => {
    const html = renderToStaticMarkup(<MarginNote comment={comment({ status: 'accepted' })} onOpen={noop} />);
    expect(html).toContain(`aria-label="замечание 12 · ${STATE_WORDS.accepted}"`);
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
  it('lists a row per alive filing with the number, the kind and the state word', () => {
    const html = renderToStaticMarkup(
      <PhoneStrip comments={[comment()]} skipQuote={null} onOpen={noop} />,
    );
    expect(html).toContain('class="phone-strip');
    expect(html).toContain('phone-strip-row');
    // BOOK-218 — the strip is a readable line: `замечание 12`, not a code and not a bare ordinal.
    expect(html).toContain('phone-strip-n ink-word-quiet">замечание 12<');
    expect(html).toContain('свидетельство');
    expect(html).toContain(`>${STATE_WORDS.waiting}<`);
    expect(html).toContain('→');
    // No count, no badge: the strip is rows, not a summary («замечаний N» never appears).
    expect(html).not.toContain('замечаний');
  });

  it('shows two rows and one quiet door to the rest', () => {
    const rows = [
      comment({ id: 'cmt_1', number: 1, createdAt: '2026-10-21T12:03:00Z' }),
      comment({ id: 'cmt_2', number: 2, createdAt: '2026-10-22T12:03:00Z' }),
      comment({ id: 'cmt_3', number: 3, createdAt: '2026-10-23T12:03:00Z' }),
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
  it('is a margin item, prints the bare number, and names the filing with its word', () => {
    const [group] = filingsForBlock([comment()], 'ch08#aa11bb22');
    const html = renderToStaticMarkup(
      <FilingMark filings={group!} onOpen={noop} />,
    );
    expect(html).toContain('filing-alive');
    // The ledger places the mark with the notes; it is never a box of its own on the prose.
    expect(html).toContain('data-margin-item="mark"');
    expect(html).toContain('data-number="12"');
    expect(html).toContain('class="filing-mark-num">12<');
    expect(html).toContain('aria-label="замечание 12 · ждёт"');
  });

  it('keeps the state in its shape: underlined while live, struck when stopped', () => {
    const [live] = filingsForBlock([comment({ status: 'accepted' })], 'ch08#aa11bb22');
    const [stopped] = filingsForBlock([comment({ status: 'rejected', refusal: 'auditor' })], 'ch08#aa11bb22');
    expect(renderToStaticMarkup(<FilingMark filings={live!} onOpen={noop} />)).toContain('ink-live');
    expect(renderToStaticMarkup(<FilingMark filings={stopped!} onOpen={noop} />)).toContain('ink-stopped');
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
    expect(html).toContain(`aria-label="замечание 12 · ${STATE_WORDS.landed}"`);
    // The tick carries no visible text at all.
    expect(html.replace(/<[^>]+>/gu, '').trim()).toBe('');
  });

  it('lets the alive filing win the slot over a landed one', () => {
    const texts = filingsForBlock(
      [
        comment({ id: 'cmt_01J9Z8K4Q7', number: 1, status: 'applied', applied: { chapter: 8, rev: 4 } }),
        comment({ id: 'cmt_01J9Z8K5AA', number: 2, status: 'new' }),
      ],
      'ch08#aa11bb22',
    );
    const html = renderToStaticMarkup(
      <FilingMark filings={texts[0]!} onOpen={noop} />,
    );
    expect(html).toContain('filing-alive');
    expect(html).not.toContain('filing-tick');
  });

  it('prints nothing for a hidden filing', () => {
    const [group] = filingsForBlock([comment({ status: 'hidden' })], 'ch08#aa11bb22');
    expect(renderToStaticMarkup(<FilingMark filings={group!} onOpen={noop} />)).toBe('');
  });
});

describe('AC4 — one vocabulary, one telling', () => {
  // BOOK-189, BOOK-218: `accepted` is «принято» until its change is in hand, a hold is
  // «проверяется», a dropped row is «снято» and a refusal is «отклонено» — never «ждёт».
  const table: Array<[CommentDto['status'], string]> = [
    ['new', STATE_WORDS.waiting],
    ['batched', STATE_WORDS.reading],
    ['delivered', STATE_WORDS.reading],
    ['accepted', STATE_WORDS.accepted],
    ['applied', STATE_WORDS.landed],
    ['superseded', STATE_WORDS.dropped],
    ['rejected', STATE_WORDS.refused],
    ['quarantined', STATE_WORDS.held],
    ['expired', STATE_WORDS.dropped],
    ['hidden', STATE_WORDS.hidden],
  ];

  it('prints the same word on the strip and the record entry, and carries it on the mark', () => {
    for (const [status, word] of table) {
      const row = comment({ status });
      const strip = renderToStaticMarkup(<PhoneStrip comments={[row]} skipQuote={null} onOpen={noop} />);
      const record = renderToStaticMarkup(<FilingCard comment={row} onClose={noop} />);
      const [group] = filingsForBlock([row], 'ch08#aa11bb22');
      const mark = renderToStaticMarkup(<FilingMark filings={group!} onOpen={noop} />);
      expect(strip, `strip ${status}`).toContain(`>${word}<`);
      expect(record, `record ${status}`).toContain(`>${word}<`);
      // The note is a pointer (no word); the mark names the word it stands for.
      if (status !== 'hidden') expect(mark, `mark ${status}`).toContain(word);
    }
  });

  it('prints «пишется» on an accepted filing only while the machine is at it', () => {
    const working = comment({ status: 'accepted', changeStatus: 'processing' });
    for (const html of [
      renderToStaticMarkup(<PhoneStrip comments={[working]} skipQuote={null} onOpen={noop} />),
      renderToStaticMarkup(<FilingCard comment={working} onClose={noop} />),
    ]) {
      expect(html).toContain(`>${STATE_WORDS.writing}<`);
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
    const refusedStrip = renderToStaticMarkup(<PhoneStrip comments={[refused]} skipQuote={null} onOpen={noop} />);
    const refusedPanel = renderToStaticMarkup(<FilingCard comment={refused} onClose={noop} />);
    for (const html of [refusedStrip, refusedPanel]) expect(count(html, 'не принято')).toBe(1);
    // The card owns the sentence beside the word; the strip is a word and a door.
    expect(refusedPanel).toContain('пересказ чужого текста без источника');

    // A landed filing: one «внесено» (the word), then the word-free receipt of every surface.
    const landed = comment({ status: 'applied', applied: { chapter: 7, rev: 4 } });
    const landedStrip = renderToStaticMarkup(<PhoneStrip comments={[landed]} skipQuote={null} onOpen={noop} />);
    const landedPanel = renderToStaticMarkup(<FilingCard comment={landed} onClose={noop} />);
    for (const html of [landedStrip, landedPanel]) expect(count(html, 'внесено')).toBe(1);
    expect(landedPanel).toContain('в главу 7. это четвёртая редакция');
    expect(landedPanel).not.toContain('право на ваш текст');
  });

  it('names the filing with its number everywhere, never a code and never a `№`', () => {
    const html = [
      renderToStaticMarkup(<MarginNote comment={comment()} onOpen={noop} />),
      renderToStaticMarkup(<PhoneStrip comments={[comment()]} skipQuote={null} onOpen={noop} />),
      renderToStaticMarkup(<FilingCard comment={comment()} onClose={noop} />),
    ].join('\n');
    expect(html).toContain('12');
    expect(html).not.toContain('№');
    expect(html).not.toMatch(/cmt_[0-9A-Z]{6,}/u);
  });

  it('has one word per state, and none of them is a phrase', () => {
    // BOOK-137 added «рассмотрено» (a decision about a record), BOOK-189 «отклонено» (a
    // refusal) and BOOK-218 the rest of the table; BOOK-206 removed the author's word, so a
    // legacy `escalated` row reads «ждёт». None is a phrase, and «внесено» is what the text says.
    expect(Object.values(STATE_WORDS)).toEqual([
      'ждёт',
      'идёт',
      'принято',
      'главу пишут',
      'внесено',
      'рассмотрено',
      'проверяется',
      'не принято',
      'не дошло',
      'снято',
      'скрыто',
    ]);
    for (const wrong of ['ждёт рассмотрения', 'в основе', 'ждёт очереди', 'фраза не изменилась']) {
      expect(Object.values(STATE_WORDS)).not.toContain(wrong);
    }
  });
});
