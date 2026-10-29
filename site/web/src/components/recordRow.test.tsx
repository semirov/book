import type { HistoryRecordDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NBSP } from '../lib/format.ts';
import { RecordRow } from './RecordRow.tsx';
import { firstDeclarations, hasRule } from './cssRules.ts';

/**
 * BOOK-65 — one public record entry: a change to the book, once, and one way in.
 *
 * The row prints the moment, the place (chapter and its own title line), the pair the book
 * wrote where an honest pair exists, the word a change the book did not take earns, whose act
 * it was and the door to its record. It prints no number, no alias, no event kind, no stage, no
 * model and no price: the chronicle is the book's past, not the workshop's logbook.
 *
 * BOOK-168 adds the second door: the place cell is a `PlaceLink` (the filing by id, else the
 * chapter), so a row that names a place can take the reader there. Its landing and its
 * change-card fallback are proved in `placeDoor.dom.test.tsx`.
 *
 * The sibling list cases (the control, the surface, the starting record) live in
 * `chronicle.test.tsx`, which is at the 500-line arch limit.
 */

const MID = `${NBSP}·${NBSP}`;

const sheets = import.meta.glob<string>('../styles/*.css', { query: '?raw', import: 'default', eager: true });

const READER: HistoryRecordDto = {
  id: 'chg_9',
  hseq: 10,
  at: '2026-10-27T12:40:00Z',
  seq: 9,
  chapter: 9,
  chapterTitle: 'Тестовая глава',
  premise: false,
  premiseLanded: false,
  alias: 'Аня',
  cause: 'reader',
  status: 'done',
  outcome: 'applied',
  reason: null,
  changeId: 'chg_9',
  recordHref: '?change=chg_9',
  span: { before: 'старый фонарь', after: 'новый фонарь' },
};

const PASS: HistoryRecordDto = {
  id: 'pass:stp_7',
  hseq: 7,
  at: '2026-10-26T06:00:00Z',
  seq: null,
  chapter: 9,
  chapterTitle: null,
  premise: false,
  premiseLanded: false,
  alias: null,
  cause: 'pass',
  status: null,
  outcome: null,
  reason: null,
  changeId: null,
  recordHref: '#проход-9-stp_7',
  span: null,
};

describe('one public record entry (BOOK-65)', () => {
  it('carries the moment, the place, the pair, the cause and one way into the record', () => {
    const html = renderToStaticMarkup(<RecordRow record={READER} />);

    expect(html).toContain(`<span class="chr-date">27.10.2026${MID}15:40</span>`);
    // The place is the chapter and its title line, both read from the server's own `chapters`,
    // and it is a door of its own (BOOK-168): this change holds no filing, so the chapter.
    expect(html).toContain('<a class="place-link chr-place" href="#ch-9">глава 9 · Тестовая глава</a>');
    // The pair the book wrote, in typographic quotes, one arrow, no doubled punctuation.
    expect(html).toContain('<span class="chr-span">«старый фонарь» → «новый фонарь»</span>');
    expect(html).toContain('<span class="chr-cause">правка читателя</span>');
    // The row's two anchors are the place and the record, and no third control exists: not a
    // button, not a card door beside the record's own.
    expect(html.match(/<button/gu)).toBeNull();
    expect(html.match(/<a /gu)).toHaveLength(2);
    expect(html).toContain('href="?change=chg_9"');
    expect(html).not.toContain('chr-deed');
  });

  it('prints no event vocabulary, no number, no alias and no raw field name', () => {
    // The record DTO has no event fields; this row proves the component would not print them
    // if one leaked in. The deed words are the five BOOK-65 removed from the list.
    const leaked = {
      ...READER,
      kind: 'change.decided',
      summary: 'правка 7 внесена',
      cascadeId: 'csc_1',
      stepId: 'stp_1',
      intent: 'в этом абзаце дважды «фонарь» — оставить один',
      deed: 'зарегистрировано · заведено дело · внесены изменения · причина установлена',
    } as unknown as HistoryRecordDto;
    const html = renderToStaticMarkup(<RecordRow record={leaked} />);

    for (const gone of [
      'правка 7 внесена',
      'заведено дело',
      'внесены изменения',
      'причина установлена',
      'дважды «фонарь»',
      'change.decided',
      'csc_1',
      'stp_1',
      // The chronicle speaks of the book: the change's number, the reader's name and any
      // engine field belong to the door behind the row, never to the row.
      'правка 9',
      'Аня',
      'этап:',
      'цена',
    ]) {
      expect(html, `the record row must not print «${gone}»`).not.toContain(gone);
    }
  });

  it('names the row for assistive tech with the same facts and the door it opens', () => {
    const html = renderToStaticMarkup(<RecordRow record={READER} />);
    expect(html).toContain(
      `aria-label="27.10.2026${MID}15:40, глава 9 · Тестовая глава, «старый фонарь» → «новый фонарь», правка читателя — открыть правку"`,
    );
  });

  it('says a pass by its own word, with no alias and its own door', () => {
    const html = renderToStaticMarkup(<RecordRow record={PASS} />);
    expect(html).toContain('<span class="chr-cause">писалась</span>');
    expect(html).toContain('<a class="place-link chr-place" href="#ch-9">глава 9</a>');
    expect(html).toContain('href="#проход-9-stp_7"');
    expect(html).toContain('>запись</a>');
    expect(html).not.toContain('правка читателя');
  });
});

describe('a change the book did not take (BOOK-65)', () => {
  it('prints its one state word and the public reason after it, and no span', () => {
    const refused: HistoryRecordDto = {
      ...READER,
      status: 'void',
      outcome: 'dropped',
      reason: 'текст успел измениться',
      span: null,
    };
    const html = renderToStaticMarkup(<RecordRow record={refused} />);
    expect(html).toContain('<span class="chr-state">не внесено</span>');
    expect(html).toContain('текст успел измениться');
    expect(html).not.toContain('chr-span');
    // The reason is a tail on the same entry, not a second line of body copy.
    expect(html).not.toContain('причина');
  });

  it('prints the word alone when a stopped change carries no reason', () => {
    const stopped: HistoryRecordDto = {
      ...READER,
      status: 'escalated',
      outcome: 'origin',
      reason: null,
      span: null,
    };
    const html = renderToStaticMarkup(<RecordRow record={stopped} />);
    expect(html).toContain('не внесено');
    expect(html).not.toContain('chr-reason');
  });

  it('keeps a landed change silent about its state: the span is the fact', () => {
    expect(renderToStaticMarkup(<RecordRow record={READER} />)).not.toContain('chr-state');
  });
});

describe('a premise on the record (BOOK-7, BOOK-65)', () => {
  it('is silent once its chapter has an edition, and says so while it has none', () => {
    const landed: HistoryRecordDto = { ...READER, premise: true, premiseLanded: true };
    expect(renderToStaticMarkup(<RecordRow record={landed} />)).not.toContain('не внесено');

    const waiting: HistoryRecordDto = { ...READER, premise: true, premiseLanded: false, status: 'void' };
    expect(renderToStaticMarkup(<RecordRow record={waiting} />)).toContain('не внесено');
  });
});

describe('the record row is dated (BOOK-DOC-50 §5)', () => {
  it('carries the record’s own date and time, whole, and never splits them', () => {
    const html = renderToStaticMarkup(<RecordRow record={PASS} />);
    // The date is one run in the markup and one unbreakable run in the base rule of the sheet.
    expect(html).toContain(`<span class="chr-date">26.10.2026${MID}09:00</span>`);
    const chronicle = sheets['../styles/chronicle.css'] ?? '';
    expect(hasRule(chronicle, '.chr-date')).toBe(true);
    expect(firstDeclarations(chronicle, '.chr-date')).toContain('white-space: nowrap');
    // …and the row is two lines: the facts wrap between items, so a phone reads the list of
    // facts and never a cut date (BOOK-128 #3900 §1).
    expect(hasRule(chronicle, '.chr-row')).toBe(true);
    expect(firstDeclarations(chronicle, '.chr-row')).toContain('display: block');
    expect(firstDeclarations(chronicle, '.chr-facts')).toContain('flex-wrap: wrap');
    expect(firstDeclarations(chronicle, '.chr-facts')).toContain('font-family: var(--mono)');
    expect(firstDeclarations(chronicle, '.chr-prose')).toContain('font-family: var(--serif)');
  });
});
