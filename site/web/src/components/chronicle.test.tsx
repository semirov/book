import type { CatalogEntry, HistoryRecordDto, HistoryTimelineDto, ParagraphChainDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NBSP } from '../lib/format.ts';
import { Chronicle, ChronicleRecords } from './Chronicle.tsx';
import { MomentControl } from './MomentControl.tsx';
import { ParagraphChain } from './ParagraphChain.tsx';
import { RecordRow } from './RecordRow.tsx';
import { ViewSwitch } from './ViewSwitch.tsx';

const CHAIN: ParagraphChainDto = {
  blockUid: 'bkd_1',
  blockId: 'ch08#0b7e9c31',
  chapter: 8,
  alive: true,
  line: 'переписано в 14:20 правкой 7 (Марк) · было: правка 3 (Аня)',
  versions: [
    {
      blockUid: 'bkd_1',
      ver: 1,
      blockId: 'ch08#aa11bb22',
      chapter: 8,
      rev: 2,
      at: '2026-10-25T11:04:00Z',
      op: 'introduced',
      textHash: 'aa11bb22',
      chars: 96,
      changeId: 'chg_3',
      changeSeq: 3,
      stepId: 'stp_1',
      actor: { kind: 'reader', identityId: 'idt_1', label: 'Аня' },
      replacedBy: null,
    },
    {
      blockUid: 'bkd_1',
      ver: 2,
      blockId: 'ch08#0b7e9c31',
      chapter: 8,
      rev: 5,
      at: '2026-10-25T11:20:00Z',
      op: 'revised',
      textHash: '0b7e9c31',
      chars: 112,
      changeId: 'chg_7',
      changeSeq: 7,
      stepId: 'stp_2',
      actor: { kind: 'reader', identityId: 'idt_2', label: 'Марк' },
      replacedBy: null,
    },
  ],
};

const CATALOG: CatalogEntry[] = [
  {
    n: 8,
    part: 1,
    title: 'Тестовая глава',
    rev: 5,
    chars: 9_000,
    blocks: 120,
    written: true,
    basis: false,
    writtenAt: '2026-10-25T11:00:00Z',
    updatedAt: '2026-10-25T11:20:00Z',
    direction: 'forward',
  },
];

const noop = (): void => undefined;

/** Newest first, as the record sends them: 27.10 15:40 · 26.10 09:00 · 21.10 09:12 (MSK). */
const ITEMS: HistoryRecordDto[] = [
  {
    hseq: 10,
    at: '2026-10-27T12:40:00Z',
    seq: 9,
    chapter: 9,
    premise: false,
    alias: 'Аня',
    status: 'done',
    outcome: 'applied',
    reason: null,
    changeId: 'chg_9',
  },
  {
    hseq: 7,
    at: '2026-10-26T06:00:00Z',
    seq: 7,
    chapter: 9,
    premise: false,
    alias: 'Марк',
    status: 'processing',
    outcome: null,
    reason: null,
    changeId: 'chg_7',
  },
  {
    hseq: 4,
    at: '2026-10-21T06:12:00Z',
    seq: 4,
    chapter: 8,
    premise: false,
    alias: 'Аня',
    status: 'pending',
    outcome: null,
    reason: null,
    changeId: 'chg_4',
  },
];

const MID = `${NBSP}·${NBSP}`;

/** Every stylesheet as text: the readout row's wrap is a layout rule jsdom cannot compute. */
const sheets = import.meta.glob<string>('../styles/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The declarations of the first rule whose selector is exactly `selector`. */
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'u'));
  return match?.[1] ?? '';
}

describe('one public record entry (BOOK-65)', () => {
  it('carries the six facts of the change and exactly one way into the card', () => {
    const html = renderToStaticMarkup(<RecordRow record={ITEMS[1]!} onOpenChange={noop} />);

    expect(html).toContain('правка 7');
    expect(html).toContain(`26.10.2026${MID}09:00`);
    expect(html).toContain('глава 9');
    expect(html).toContain('Марк');
    expect(html).toContain('идёт');
    // One control, and the only link is the card — no «прицел», no second door.
    expect(html.match(/<button/gu)).toHaveLength(1);
    expect(html).not.toContain('прицел');
    expect(html).not.toContain('chr-deed');
    expect(html).toContain('карточка');
  });

  it('prints no event vocabulary at all, even when a row is handed one', () => {
    // The record DTO has no event fields; this row proves the component would not print them
    // if one leaked in. The deed words are the five this pass removed from the list.
    const leaked = {
      ...ITEMS[1]!,
      kind: 'change.decided',
      summary: 'правка 7 внесена',
      cascadeId: 'csc_1',
      stepId: 'stp_1',
      intent: 'в этом абзаце дважды «фонарь» — оставить один',
      deed: 'зарегистрировано · заведено дело · внесены изменения · причина установлена',
    } as unknown as HistoryRecordDto;
    const html = renderToStaticMarkup(<RecordRow record={leaked} onOpenChange={noop} />);

    for (const gone of [
      'правка 7 внесена',
      'заведено дело',
      'внесены изменения',
      'причина установлена',
      'дважды «фонарь»',
      'change.decided',
      'csc_1',
      'stp_1',
    ]) {
      expect(html, `the record row must not print «${gone}»`).not.toContain(gone);
    }
  });

  it('names the row for assistive tech with the same six facts, and no event vocabulary', () => {
    const html = renderToStaticMarkup(<RecordRow record={ITEMS[1]!} onOpenChange={noop} />);
    expect(html).toContain(
      `aria-label="26.10.2026${MID}09:00, правка 7, глава 9, Марк, идёт — открыть карточку правки"`,
    );
  });
});

describe('a refused change on the record (BOOK-65)', () => {
  it('prints its one outcome word and the public reason after it', () => {
    const refused: HistoryRecordDto = {
      ...ITEMS[0]!,
      status: 'void',
      outcome: 'dropped',
      reason: 'текст успел измениться',
    };
    const html = renderToStaticMarkup(<RecordRow record={refused} onOpenChange={noop} />);
    expect(html).toContain('снято');
    expect(html).toContain('текст успел измениться');
    // The reason is a tail on the same entry, not a second line of body copy.
    expect(html).not.toContain('причина');
  });

  it('prints the word alone when a stopped change carries no reason', () => {
    const stopped: HistoryRecordDto = { ...ITEMS[0]!, status: 'escalated', outcome: 'origin', reason: null };
    const html = renderToStaticMarkup(<RecordRow record={stopped} onOpenChange={noop} />);
    expect(html).toContain('остановлено');
    expect(html).not.toContain('chr-reason');
  });
});

describe('a premise on the record (BOOK-7, BOOK-65)', () => {
  it('carries its own number and speaks of a «замысел», agreeing with the noun', () => {
    const premise: HistoryRecordDto = { ...ITEMS[0]!, premise: true, status: 'done', outcome: 'applied' };
    const html = renderToStaticMarkup(<RecordRow record={premise} onOpenChange={noop} />);
    expect(html).toContain('замысел 9');
    expect(html).toContain('учтён');
    // The number is present on every entry: a premise is not an exception to AC5.
    expect(html).toContain('<span class="chr-seq">замысел 9</span>');
  });
});

describe('the record row is dated (BOOK-DOC-50 §5)', () => {
  it('carries the record’s own date and time, whole, and never splits them', () => {
    const html = renderToStaticMarkup(<RecordRow record={ITEMS[1]!} onOpenChange={noop} />);
    // The date is one run in the markup and one unbreakable run in the sheet.
    expect(html).toContain(`<span class="chr-date">26.10.2026${MID}09:00</span>`);
    const date = declarations(sheets['../styles/chronicle.css'] ?? '', '.chr-date');
    expect(date).toContain('white-space: nowrap');
    // …and the row wraps between facts, so a phone reads it as a list, not a cut date.
    const row = declarations(sheets['../styles/chronicle.css'] ?? '', '.chr-row');
    expect(row).toContain('flex-wrap: wrap');
  });
});

describe('the moment’s control (BOOK-DOC-50 §2–§5)', () => {
  it('prints a dated readout, the record counter and both dated ends', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={7} onInput={noop} onCommit={noop} />,
    );
    // The readout answers "what time" with the record under the thumb.
    expect(html).toContain(`26.10.2026${MID}09:00`);
    expect(html).toContain('запись 2 из 3');
    // Both ends are words over dated moments: the log's own ends, not the thumb's.
    expect(html).toContain('начало книги');
    expect(html).toContain('сейчас');
    expect(html).toContain('<span class="chr-end-date">21.10.2026</span>');
    expect(html).toContain(`<span class="chr-end-clock">${MID}09:12</span>`);
    expect(html).toContain('<span class="chr-end-date">с 27.10.2026</span>');
    expect(html).toContain(`<span class="chr-end-clock">${MID}15:40</span>`);
    // One rail, native and labelled, with the readout as its value text.
    expect(html).toContain('type="range"');
    expect(html).toContain('aria-label="перейти к моменту"');
    expect(html).toContain(`aria-valuetext="26.10.2026${MID}09:00"`);
    // BOOK-30: the fill is a CSSOM write, never a style attribute.
    expect(html).not.toMatch(/style=/u);
  });

  it('prints each dated end as two unbreakable parts and never splits a date or a time', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={7} onInput={noop} onCommit={noop} />,
    );
    // The date and the ` · HH:MM` tail, from the one source (`momentParts`): the string is
    // whole, split only where the box may wrap.
    const parts = [...html.matchAll(/<span class="chr-end-(?:date|clock)">([^<]*)<\/span>/gu)].map(
      (match) => match[1],
    );
    expect(parts).toEqual(['21.10.2026', `${MID}09:12`, 'с 27.10.2026', `${MID}15:40`]);
    expect(`${parts[0]}${parts[1]}`).toBe(`21.10.2026${MID}09:12`);
    expect(`${parts[2]}${parts[3]}`).toBe(`с 27.10.2026${MID}15:40`);

    const sheet = sheets['../styles/chronicle.css'] ?? '';
    // The box wraps between the parts only, and each part is an unbreakable run at 12 px…
    const at = declarations(sheet, '.chr-end-at');
    expect(at).toContain('flex-wrap: wrap');
    expect(at).toContain('white-space: nowrap');
    expect(at).toContain('font-size: var(--fs-micro)');
    // …and no rule may cut a digit run: a date, a year and a time stay whole (§3).
    expect(sheet.replace(/\/\*[\s\S]*?\*\//gu, '')).not.toMatch(/overflow-wrap|word-break/u);
  });

  it('appends «сейчас» at the right edge and reuses the same text as the range value', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={null} onInput={noop} onCommit={noop} />,
    );
    expect(html).toContain(`27.10.2026${MID}15:40${MID}сейчас`);
    expect(html).toContain(`aria-valuetext="27.10.2026${MID}15:40${MID}сейчас"`);
    expect(html).toContain('запись 3 из 3');
  });

  it('dates the rest position by the log’s own last moment, not by the newest record (BOOK-65 M2)', () => {
    // A machine pass moved the clock past the newest change: `lastHseq` 12 at 18:05 MSK, while
    // the newest entry is still 10 at 15:40. «сейчас» must name the logged instant, not the
    // entry's.
    const html = renderToStaticMarkup(
      <MomentControl
        items={ITEMS}
        lastHseq={12}
        lastAt="2026-10-27T15:05:00Z"
        more={false}
        thumb={null}
        onInput={noop}
        onCommit={noop}
      />,
    );
    expect(html).toContain(`27.10.2026${MID}18:05${MID}сейчас`);
    expect(html).toContain('<span class="chr-end-date">с 27.10.2026</span>');
    expect(html).toContain(`<span class="chr-end-clock">${MID}18:05</span>`);
    // The newest entry keeps its own date below; only the rest position speaks for the clock.
    expect(html).not.toContain(`27.10.2026${MID}15:40${MID}сейчас`);
  });

  it('says «до …» before the oldest loaded record only when an older page exists', () => {
    const before = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more thumb={0} onInput={noop} onCommit={noop} />,
    );
    expect(before).toContain(`до${NBSP}21.10.2026${MID}09:12`);
    const clamped = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={0} onInput={noop} onCommit={noop} />,
    );
    expect(clamped).not.toContain('до');
    expect(clamped).toContain(`21.10.2026${MID}09:12`);
  });

  it('offers exactly one «сейчас» control and no way back to it inside the past', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={7} onInput={noop} onCommit={noop} />,
    );
    const buttons = html.match(/<button[\s\S]*?<\/button>/gu) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0] ?? '').toContain('сейчас');
    expect(html).not.toContain('вернуться к «сейчас»');
  });

  it('draws no rail under two records', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS.slice(0, 1)} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={null} onInput={noop} onCommit={noop} />,
    );
    expect(html).not.toContain('type="range"');
    expect(html).toContain('начало книги');
    expect(html).toContain('сейчас');
  });
});

describe('the readout row on a narrow phone (BOOK-DOC-50 §2)', () => {
  it('wraps the counter onto a second line instead of spilling, and stays 22 px on desktop', () => {
    const head = declarations(sheets['../styles/chronicle.css'] ?? '', '.scrub-head');
    expect(head).toContain('flex-wrap: wrap');
    expect(head).toContain('row-gap: 2px');
    expect(head).toContain('min-height: 22px');
    // The inherited 1.68 line box is 25.2 px, so the one-line row is only 22 px with this.
    expect(head).toContain('line-height: 22px');
    // A fixed height would clip the wrapped line; `min-height` keeps one-line rows at 22 px.
    expect(head).not.toMatch(/(?:^|[;\s])height:\s*22px/u);
    // …and nothing in the markup pins a width that would defeat the wrap (BOOK-30).
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} lastAt={ITEMS[0]!.at} more={false} thumb={7} onInput={noop} onCommit={noop} />,
    );
    expect(html).toContain('class="scrub-head"');
    expect(html).not.toMatch(/style=/u);
  });
});

describe('the chronicle’s surface (§11.10)', () => {
  it('renders the toggle with the active view marked', () => {
    const book = renderToStaticMarkup(<ViewSwitch view="book" onChange={noop} live />);
    expect(book).toContain('книга');
    expect(book).toContain('хроника');
    expect(book).toContain('aria-pressed="true"');
    const chronicle = renderToStaticMarkup(<ViewSwitch view="chronicle" onChange={noop} live />);
    expect(chronicle).toContain('is-on');
  });

  it('renders no filter chips and no tick strip, and no readout before an answer', () => {
    const html = renderToStaticMarkup(
      <Chronicle catalog={CATALOG} frontRev={1} tick={0} onOpenChange={noop} started live />,
    );
    // BOOK-DOC-50 §9: the chips filtered the list while the rail kept the whole log.
    for (const chip of ['всё', 'правки', 'черновики', 'первая страница', 'перезаписи']) {
      expect(html, `the filter chip «${chip}» is gone`).not.toContain(chip);
    }
    expect(html).not.toContain('chr-filter');
    // …and the unlabelled tick strip is gone with them.
    expect(html).not.toContain('scrub-ticks');
    // With no records there is no readout, no ends, no rail and no zero counter.
    expect(html).not.toContain('type="range"');
    expect(html).not.toContain('запись 0');
    expect(html).not.toContain('начало книги');
    // BOOK-DOC-43 §10 (BOOK-66): an absence is a fact about an answer, so «пока ничего не
    // записано» waits for the timeline — the first render is busy and prints no absence.
    expect(html).not.toContain('пока ничего не записано');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('вернуться к «сейчас»');
    // BOOK-30: no geometry in the markup; the fill is a CSSOM write.
    expect(html).not.toMatch(/style=/u);
  });

  it('renders a paragraph chain with the SPEC’s copy and every version', () => {
    const html = renderToStaticMarkup(
      <ParagraphChain chain={CHAIN} loading={false} failed={false} onClose={noop} onRetry={noop} live />,
    );
    expect(html).toContain('откуда эта фраза');
    expect(html).toContain('переписано в 14:20 правкой 7 (Марк) · было: правка 3 (Аня)');
    expect(html).toContain('эта строка сейчас в тексте · глава 8');
    expect(html).toContain('написано');
    expect(html).toContain('ch08#0b7e9c31');
    // The chain never shows the text of any version — it is metadata and ids only.
    expect(html).not.toContain('Тестовая глава');
  });

  it('says so when a paragraph has no history — and only then', () => {
    const empty = renderToStaticMarkup(
      <ParagraphChain chain={null} loading={false} failed={false} onClose={noop} onRetry={noop} live />,
    );
    expect(empty).toContain('у этой строки нет истории');
    // BOOK-DOC-43 §4 (BOOK-66): before 150 ms the panel shows only its head. The threshold
    // itself is proven in `paragraphChain.dom.test.tsx`; here the first render is quiet.
    const loading = renderToStaticMarkup(
      <ParagraphChain chain={null} loading failed={false} onClose={noop} onRetry={noop} live />,
    );
    expect(loading).not.toContain('у этой строки нет истории');
    expect(loading).not.toContain('цепочка читается');
    expect(loading).not.toContain('role="status"');
    expect(loading).toContain('aria-busy="true"');
  });

  it('separates a failed read from an absence (BOOK-70)', () => {
    // A request that never answered is not a paragraph without history: the panel says which
    // fact it has, and offers the chronicle's own retry — same class, same shape.
    const failed = renderToStaticMarkup(
      <ParagraphChain chain={null} loading={false} failed onRetry={noop} onClose={noop} live />,
    );
    expect(failed).toContain('история не прочиталась');
    expect(failed).toContain('class="state-line"');
    expect(failed).toContain('повторить');
    expect(failed).not.toContain('нет истории');
    expect(failed).not.toContain('цепочка читается');
  });
});

/**
 * BOOK-56 — a begun book's chronicle holds exactly one record, its beginning. The row is not
 * a change: no number, author, card or scrub target. The empty-log sentence is another fact.
 */
describe('the one starting record of a begun book (BOOK-56)', () => {
  // The log's first moment and no reader change: the one record is where the book began.
  const begun = { lastHseq: 3, lastAt: '2026-10-21T06:12:00Z', firstAt: '2026-10-21T06:12:00Z', at: '2026-10-25T12:00:00Z', items: [], nextBefore: null } as HistoryTimelineDto;

  it('prints the quiet line and one «начало книги» row with the log’s first moment', () => {
    const html = renderToStaticMarkup(<ChronicleRecords timeline={begun} failed={false} onOpenChange={noop} />);
    expect(html).toContain('перематывать пока нечего: книга ещё не правила читателем');
    expect(html).toContain('class="chr-timeline"');
    expect(html).toContain('<li class="chr-row">');
    expect(html).toContain('<span class="chr-seq">начало книги</span>');
    expect(html).toContain(`<span class="chr-date">21.10.2026${MID}09:12</span>`);
    // Exactly one row, and no way to act on it: the moment moves only through the control.
    expect(html.match(/<li/gu)).toHaveLength(1);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('карточка');
    expect(html).not.toContain('class="chr-alias"');
    expect(html).not.toContain('правка');
    // The empty-log sentence is a different fact; the two never print together.
    expect(html).not.toContain('пока ничего не записано');
  });

  it('keeps «пока ничего не записано» for an empty log and claims nothing after a failure', () => {
    const empty = renderToStaticMarkup(
      <ChronicleRecords timeline={{ ...begun, firstAt: null }} failed={false} onOpenChange={noop} />,
    );
    expect(empty).toContain('пока ничего не записано');
    expect(empty).not.toContain('начало книги');
    // A failed read is not an absence: the sentence belongs to an answer that came back.
    const failed = renderToStaticMarkup(
      <ChronicleRecords timeline={{ ...begun, firstAt: null }} failed onOpenChange={noop} />,
    );
    expect(failed).not.toContain('пока ничего не записано');
  });

  it('leaves the record list exactly as it is once a reader change exists', () => {
    const html = renderToStaticMarkup(
      <ChronicleRecords timeline={{ ...begun, items: ITEMS, lastHseq: 10 }} failed={false} onOpenChange={noop} />,
    );
    expect(html.match(/<li/gu)).toHaveLength(3);
    expect(html).not.toContain('перематывать пока нечего');
    expect(html).not.toContain('начало книги');
  });
});

/**
 * BOOK-DOC-43 §4, §6, §7 — the timeline's wait (BOOK-66).
 *
 * The first render is the quiet one: the surface is busy from the request, and nothing below
 * the rail claims a fact it does not hold. The two thresholds (150 ms, 2 000 ms) and the
 * settle are proven in `chronicle.dom.test.tsx`, where a clock exists.
 */
describe('the chronicle while the timeline is in flight', () => {
  it('is busy from the request and prints no absence before the answer', () => {
    const html = renderToStaticMarkup(
      <Chronicle catalog={CATALOG} frontRev={1} tick={0} onOpenChange={noop} started live />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('пока ничего не записано');
    expect(html).not.toContain('chr-timeline');
  });
});
