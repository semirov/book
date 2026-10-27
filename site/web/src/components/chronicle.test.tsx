import type { CatalogEntry, HistoryEventDto, ParagraphChainDto } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { NBSP } from '../lib/format.ts';
import { Chronicle, TimelineRow } from './Chronicle.tsx';
import { MomentControl } from './MomentControl.tsx';
import { ParagraphChain } from './ParagraphChain.tsx';
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

/** Newest first, as the timeline sends them: 27.10 15:40 · 26.10 09:00 · 21.10 09:12 (MSK). */
const ITEMS: HistoryEventDto[] = [
  {
    hseq: 10,
    at: '2026-10-27T12:40:00Z',
    kind: 'front.revised',
    chapter: null,
    isFront: true,
    rev: 3,
    changeId: null,
    cascadeId: null,
    stepId: null,
    author: { kind: 'writer', identityId: null, label: 'автор' },
    summary: 'первая страница переписана',
  },
  {
    hseq: 7,
    at: '2026-10-26T06:00:00Z',
    kind: 'chapter.created',
    chapter: 9,
    isFront: false,
    rev: 1,
    changeId: null,
    cascadeId: null,
    stepId: null,
    author: { kind: 'writer', identityId: null, label: 'автор' },
    summary: 'глава 9 написана',
  },
  {
    hseq: 4,
    at: '2026-10-21T06:12:00Z',
    kind: 'chapter.created',
    chapter: 8,
    isFront: false,
    rev: 1,
    changeId: null,
    cascadeId: null,
    stepId: null,
    author: { kind: 'writer', identityId: null, label: 'автор' },
    summary: 'глава 8 написана',
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

describe('the chronicle’s deed line', () => {
  const decided: HistoryEventDto = {
    hseq: 42,
    at: '2026-10-25T12:05:00Z',
    kind: 'change.decided',
    chapter: 8,
    isFront: false,
    rev: null,
    changeId: 'chg_1',
    cascadeId: 'csc_1',
    stepId: null,
    author: { kind: 'writer', identityId: null, label: 'автор' },
    summary: 'правка 7 внесена',
  };

  it('prints the same five words as the card on a decided row', () => {
    const html = renderToStaticMarkup(
      <TimelineRow
        event={decided}
        deed="зарегистрировано · заведено дело · внесены изменения · причина установлена · оформление"
        onPick={noop}
        onOpenChange={noop}
      />,
    );
    expect(html).toContain('зарегистрировано · заведено дело · внесены изменения');
    expect(html).toContain('причина установлена · оформление');
    expect(html).not.toContain('чужой');
  });

  it('shows no deed line when the change is outside the feed — no data, no claim', () => {
    const html = renderToStaticMarkup(<TimelineRow event={decided} deed={null} onPick={noop} onOpenChange={noop} />);
    expect(html).not.toContain('зарегистрировано');
  });
});

describe('a document statement in the chronicle (BOOK-18)', () => {
  const statement: HistoryEventDto = {
    hseq: 51,
    at: '2026-10-25T12:10:00Z',
    kind: 'document.status',
    chapter: null,
    isFront: false,
    rev: null,
    changeId: 'chg_9',
    cascadeId: 'csc_9',
    stepId: null,
    author: { kind: 'writer', identityId: null, label: 'автор' },
    summary: 'статус документа приказ № 4 изменён в главах 12, 19, 44',
  };

  it('prints the one line the server built, with the book as its target', () => {
    const html = renderToStaticMarkup(<TimelineRow event={statement} deed={null} onPick={noop} onOpenChange={noop} />);
    expect(html).toContain('статус документа приказ № 4 изменён в главах 12, 19, 44');
    expect(html).toContain('книга');
    expect(html).toContain('правка');
    // No role and no finding reach the row: only the statement, the target and the change.
    expect(html).not.toMatch(/editor|consultant|blocker/u);
  });
});

describe('the record row is dated (BOOK-DOC-50 §5)', () => {
  it('carries the record’s own date and time in its aria-label', () => {
    const html = renderToStaticMarkup(<TimelineRow event={ITEMS[1]!} deed={null} onPick={noop} onOpenChange={noop} />);
    expect(html).toContain(
      `aria-label="26.10.2026${MID}09:00, глава 9 написана — книга на этот момент"`,
    );
    // The visible cell stays the row's own clock; the date comes from the day heading above.
    expect(html).toContain('09:00');
  });
});

describe('the moment’s control (BOOK-DOC-50 §2–§5)', () => {
  it('prints a dated readout, the record counter and both dated ends', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} more={false} thumb={7} onInput={noop} onCommit={noop} />,
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
      <MomentControl items={ITEMS} lastHseq={10} more={false} thumb={7} onInput={noop} onCommit={noop} />,
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
      <MomentControl items={ITEMS} lastHseq={10} more={false} thumb={null} onInput={noop} onCommit={noop} />,
    );
    expect(html).toContain(`27.10.2026${MID}15:40${MID}сейчас`);
    expect(html).toContain(`aria-valuetext="27.10.2026${MID}15:40${MID}сейчас"`);
    expect(html).toContain('запись 3 из 3');
  });

  it('says «до …» before the oldest loaded record only when an older page exists', () => {
    const before = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} more thumb={0} onInput={noop} onCommit={noop} />,
    );
    expect(before).toContain(`до${NBSP}21.10.2026${MID}09:12`);
    const clamped = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} more={false} thumb={0} onInput={noop} onCommit={noop} />,
    );
    expect(clamped).not.toContain('до');
    expect(clamped).toContain(`21.10.2026${MID}09:12`);
  });

  it('offers exactly one «сейчас» control and no way back to it inside the past', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS} lastHseq={10} more={false} thumb={7} onInput={noop} onCommit={noop} />,
    );
    const buttons = html.match(/<button[\s\S]*?<\/button>/gu) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0] ?? '').toContain('сейчас');
    expect(html).not.toContain('вернуться к «сейчас»');
  });

  it('draws no rail under two records', () => {
    const html = renderToStaticMarkup(
      <MomentControl items={ITEMS.slice(0, 1)} lastHseq={10} more={false} thumb={null} onInput={noop} onCommit={noop} />,
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
      <MomentControl items={ITEMS} lastHseq={10} more={false} thumb={7} onInput={noop} onCommit={noop} />,
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
      <Chronicle catalog={CATALOG} frontRev={1} tick={0} changes={[]} onOpenChange={noop} live />,
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
 * BOOK-DOC-43 §4, §6, §7 — the timeline's wait (BOOK-66).
 *
 * The first render is the quiet one: the surface is busy from the request, and nothing below
 * the rail claims a fact it does not hold. The two thresholds (150 ms, 2 000 ms) and the
 * settle are proven in `chronicle.dom.test.tsx`, where a clock exists.
 */
describe('the chronicle while the timeline is in flight', () => {
  it('is busy from the request and prints no absence before the answer', () => {
    const html = renderToStaticMarkup(
      <Chronicle catalog={CATALOG} frontRev={1} tick={0} changes={[]} onOpenChange={noop} live />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('class="skel');
    expect(html).not.toContain('пока ничего не записано');
    expect(html).not.toContain('chr-timeline');
  });
});
