import { AUTHOR_COLORS, type CommentDto, type FrontDto, type MyTraceDto, type StateSnapshot } from '@book/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { queueLabel } from './format.ts';
import { wingLine, wingReachedCopy, wingStateCopy } from './cascade.ts';
import { CHIP_MAX_CHARS, commentStatusLine, type CommentLine } from './commentView.ts';
import { Colophon } from '../components/Colophon.tsx';
import { Discussion } from '../components/Discussion.tsx';
import { Header } from '../components/Header.tsx';
import { OwnTrace } from '../components/OwnTrace.tsx';
import { TitleSheet } from '../components/TitleSheet.tsx';

/**
 * BOOK-70 — the chip table, pinned.
 *
 * Every string this pass defines, with the surface that prints it and its character length.
 * The cap is the form audit's: a chip of tier `state`, `count` or `ref` is at most 24 characters
 * — one line, never ellipsized, never two voices. A `sentence` (a clause or a receipt) may run
 * to 90, and a `line` is the ribbon's own line, which is not a chip and carries no cap.
 *
 * The filing states are not hand-copied: `FILING_PINS` is produced by `commentStatusLine` itself
 * (status × premise × whether a record exists), so the table and the panel cannot disagree about
 * which state is a chip and which is a sentence.
 *
 * The one documented exemption is the zero-state sentence «у этой строки нет истории» (25): it
 * is a sentence a panel prints where a chip would be a lie, not a chip that outgrew its box.
 */
export type ChipPin = {
  surface: string;
  condition: string;
  text: string;
  length: number;
  tier: 'state' | 'count' | 'ref' | 'sentence' | 'line';
  exempt?: 'zero-state sentence';
};

export const CHIP_PINS: readonly ChipPin[] = [
  { surface: 'discussion · .qline', condition: 'an empty queue', text: 'в очереди пусто', length: 15, tier: 'count' },
  { surface: 'discussion · .qline', condition: 'three changes waiting', text: 'в очереди 3 правки', length: 18, tier: 'count' },
  { surface: 'discussion · .qline', condition: 'eleven changes waiting', text: 'в очереди 11 правок', length: 19, tier: 'count' },
  { surface: 'discussion · .sec-meta', condition: 'no filings', text: 'замечаний нет', length: 13, tier: 'count' },
  { surface: 'discussion · .sec-meta', condition: 'three filings', text: '3 замечания', length: 11, tier: 'count' },
  { surface: 'ribbon · wing state', condition: 'the wing has finished', text: 'остановилось', length: 12, tier: 'state' },
  { surface: 'ribbon · wing state', condition: 'the wing was stopped', text: 'остановлено', length: 11, tier: 'state' },
  { surface: 'ribbon · wing state', condition: 'the wing is moving', text: 'идёт', length: 4, tier: 'state' },
  { surface: 'ribbon · wing line', condition: 'one wing, one wave', text: 'вниз · идёт', length: 11, tier: 'line' },
  {
    surface: 'ribbon · wing line',
    condition: 'a second wave, by decision — a line, not a chip',
    text: 'вверх · волна 2 · решением · идёт',
    length: 33,
    tier: 'line',
  },
  { surface: 'focus · wing reached', condition: 'one chapter reached', text: '07', length: 2, tier: 'ref' },
  { surface: 'ribbon · wing reached', condition: 'nothing reached — nothing rendered', text: '', length: 0, tier: 'ref' },
  { surface: 'chapter · .ch-print', condition: 'the text is arriving', text: 'печатается', length: 10, tier: 'state' },
  {
    surface: 'chapter · .ch-data',
    condition: 'a written chapter',
    text: '9\u00a0003\u00a0знака · 12:52',
    length: 19,
    tier: 'line',
  },
  { surface: 'cover · .author-plus', condition: 'three surviving readers', text: '+ 3', length: 3, tier: 'ref' },
  {
    surface: 'chapter chain · .state-line',
    condition: 'the read failed',
    text: 'история не прочиталась',
    length: 22,
    tier: 'state',
  },
  {
    surface: 'chapter chain · .chr-empty',
    condition: 'the paragraph really has no history',
    text: 'у этой строки нет истории',
    length: 25,
    tier: 'state',
    exempt: 'zero-state sentence',
  },
  { surface: 'chapter chain · .chr-empty', condition: 'the read is in flight', text: 'цепочка читается…', length: 17, tier: 'line' },
  { surface: 'colophon', condition: 'no chapter has text', text: 'книга · глав ещё нет', length: 20, tier: 'sentence' },
  { surface: 'colophon', condition: 'twelve written chapters', text: 'книга · 12 глав из 42', length: 21, tier: 'sentence' },
  {
    surface: 'filing panel · .filing-state',
    condition: 'a landed filing (the receipt is the fact line, not the state)',
    text: 'внесено',
    length: 7,
    tier: 'state',
  },
];

/** What a chip of each tier may measure, in characters (the form audit's cap). */
const CAP = { state: 24, count: 24, ref: 24, sentence: 90 } as const;

/**
 * One comment fixture, for the filing states: every field the line reads, nothing else.
 */
function comment(overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: 'cmt_01J9Z8K5A4Q7',
    chapter: 8,
    anchor: { blockId: null, blockIndex: null, quote: null, prefix: null, suffix: null, resolved: true },
    author: 'Аня',
    authorColor: AUTHOR_COLORS[0],
    body: 'Тут дважды «слово».',
    proposedText: null,
    interventionKind: null,
    premise: false,
    status: 'new',
    frame: 'untouched',
    reason: null,
    createdAt: '2026-10-25T12:00:00Z',
    decidedAt: null,
    changeId: null,
    applied: null,
    refusal: null,
    attempt: null,
    ...overrides,
  };
}

const STATUSES = ['new', 'batched', 'delivered', 'accepted', 'applied', 'superseded', 'rejected', 'quarantined', 'expired', 'hidden'] as const;

/** What a reader sees: the tags stripped, so a chip's own text can be compared exactly. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/gu, '');
}

export type FilingPin = {
  status: (typeof STATUSES)[number];
  premise: boolean;
  applied: boolean;
  state: string;
  form: CommentLine['form'];
};

/** Every filing state the panel can print, taken from the function that decides it. */
export const FILING_PINS: readonly FilingPin[] = STATUSES.flatMap((status) =>
  [false, true].flatMap((premise) =>
    [false, true].map((applied) => {
      const line = commentStatusLine(
        comment({ status, premise, applied: applied ? { chapter: 12, rev: 3 } : null }),
      );
      return { status, premise, applied, state: line.state, form: line.form };
    }),
  ),
);

describe('the chip table (BOOK-70)', () => {
  it('keeps every state, count and reference chip inside 24 characters', () => {
    for (const pin of CHIP_PINS) {
      if (pin.tier === 'line' || pin.tier === 'sentence') continue;
      expect(pin.text.length, pin.text).toBe(pin.length);
      if (pin.exempt !== undefined) continue;
      expect(pin.length, pin.text).toBeLessThanOrEqual(CAP[pin.tier]);
    }
  });

  it('lets exactly one string past the cap, and only as the documented zero-state sentence', () => {
    const over = CHIP_PINS.filter((pin) => pin.tier !== 'line' && pin.tier !== 'sentence' && pin.text.length > 24);
    expect(over.map((pin) => pin.exempt)).toEqual(['zero-state sentence']);
    expect(over[0]?.text).toBe('у этой строки нет истории');
  });

  it('keeps a sentence a sentence: at most 90 characters, and it may wrap', () => {
    for (const pin of CHIP_PINS.filter((entry) => entry.tier === 'sentence')) {
      expect(pin.length).toBeLessThanOrEqual(CAP.sentence);
      expect(pin.text.length).toBe(pin.length);
      expect(pin.text).toContain(' · ');
    }
  });

  it('caps every filing state by its form, from the one function that decides the form', () => {
    // 10 statuses × 2 premise flags × (no record | a record) — the whole matrix, not a sample.
    expect(FILING_PINS).toHaveLength(40);
    for (const pin of FILING_PINS) {
      if (pin.form === 'chip') {
        expect(pin.state.length, pin.state).toBeLessThanOrEqual(CHIP_MAX_CHARS);
        // A chip may not hold a clause: the punctuation is the second voice.
        expect(pin.state, pin.state).not.toMatch(/ · |: /u);
      } else {
        expect(pin.state.length, pin.state).toBeLessThanOrEqual(90);
      }
    }
  });

  it('pins the filing states the audits named: one of three words, always a chip', () => {
    const states = [...new Set(FILING_PINS.map((pin) => pin.state))].sort();
    expect(states).toEqual(['внесено', 'ждёт', 'идёт']);
    for (const pin of FILING_PINS) {
      expect(pin.form, pin.state).toBe('chip');
      expect(pin.state.length, pin.state).toBeLessThanOrEqual(CHIP_MAX_CHARS);
    }
  });

  it('takes the filing table from commentStatusLine, so the panel and the table cannot drift', () => {
    for (const pin of FILING_PINS) {
      const line = commentStatusLine(
        comment({ status: pin.status, premise: pin.premise, applied: pin.applied ? { chapter: 12, rev: 3 } : null }),
      );
      expect(pin.state, pin.status).toBe(line.state);
      expect(pin.form, pin.state).toBe(line.form);
    }
  });

  it('is produced by the code that prints it, so the table cannot drift', () => {
    const text = (surface: string): string[] => CHIP_PINS.filter((pin) => pin.surface === surface).map((pin) => pin.text);
    expect(queueLabel(0)).toBe(text('discussion · .qline')[0]);
    expect(queueLabel(3)).toBe(text('discussion · .qline')[1]);
    expect(queueLabel(11)).toBe(text('discussion · .qline')[2]);
    expect(wingStateCopy('settled')).toBe('остановилось');
    expect(wingStateCopy('stopped')).toBe('остановлено');
    expect(wingLine('down', { frontier: 7, wave: 1, state: 'moving', reached: [7] })).toBe(text('ribbon · wing line')[0]);
    expect(wingLine('up', { frontier: 9, wave: 2, state: 'moving', reached: [9] })).toBe(text('ribbon · wing line')[1]);
    expect(wingReachedCopy({ frontier: 7, wave: 1, state: 'settled', reached: [7] })).toBe(text('focus · wing reached')[0]);
    expect(wingReachedCopy({ frontier: 7, wave: 1, state: 'settled', reached: [] })).toBe(text('ribbon · wing reached')[0]);
  });
});

/**
 * The other half of the audit: the words the table removed may not appear in the markup of the
 * surface that used to print them. «Состояние: …», «не написана», «шагов пока нет»,
 * «правок пока нет», «+ 0» and «0 замечаний» are pinned in their own component tests
 * (filingPanel, chapterArticle, changeCard, ownTrace, bookMatter, discussion).
 */
describe('the removed chips are gone from their surfaces', () => {
  const state = {
    version: 1,
    at: '',
    engine: { status: 'unknown', heartbeatAt: null, laneId: null },
    phase: 'draft',
    front: { title: 'Книга', about: null, rev: 1, updatedAt: null },
    chapters: { total: 42, written: [], empty: [], count: 0, totalChars: 0 },
    cursors: {},
    toc: [],
    meeting: { forwardFront: null, backwardFront: null, gap: 42, converged: false, seam: 'not_reached' },
    cascade: null,
    queue: { depth: 0, byState: { pending: 0, processing: 0, stale: 0, escalated: 0, done24h: 0 }, head: null, processing: null, lastDecidedAt: null },
    revising: [],
    current: null,
    unresolved: [],
    activity: { lastFileChangeAt: null, lastEngineEventAt: null, lastLogLineAt: null, source: 'files' },
  } as unknown as StateSnapshot;

  const front: FrontDto = {
    title: 'Книга',
    about: null,
    rev: 1,
    toc: [],
    imprint: { author: 'Филипп Семиров', copyright: '© Филипп Семиров' },
    authors: { count: 0, measuredAt: '2026-10-27T08:00:00Z' },
  };

  const trace: MyTraceDto = { label: 'Аня', edits: 0, chars: 0, share: 0, series: [], hidden: false, survivedRevisions: 0 };

  beforeAll(() => {
    // The theme is read from the document at first paint, as `colophon.test.tsx` does.
    vi.stubGlobal('document', {
      documentElement: { getAttribute: () => 'day', setAttribute: () => undefined },
      querySelector: () => null,
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('prints no state line in the header — the chip is gone, not emptied', () => {
    const html = renderToStaticMarkup(<Header state={state} ribbon={null} catalog={[]} markers={[]} onOpenChange={() => undefined} live />);
    // BOOK-112: the head prints the book's own title and nothing else.
    expect(textOf(html)).toBe('Книга');
    expect(html).not.toContain('class="live"');
    expect(html).not.toContain('глав ещё нет');
    expect(html).not.toContain('class="queue"');
    expect(html).not.toContain('замечаний');
    expect(html).not.toContain('в очереди');
  });

  it('prints the byline alone on a book nobody has touched', () => {
    const html = renderToStaticMarkup(<TitleSheet front={front} />);
    expect(html).not.toContain('+ 0');
    expect(html).not.toContain('author-plus');
  });

  it('keeps the byline chip exactly «+ 3»: the space belongs to the sentence, not the chip', () => {
    const html = renderToStaticMarkup(
      <TitleSheet front={{ ...front, authors: { count: 3, measuredAt: '2026-10-27T08:00:00Z' } }} />,
    );
    expect(html).toContain('Филипп Семиров <span class="author-plus">+ 3</span>');
    expect(textOf(html)).toContain('Филипп Семиров + 3');
  });

  it('prints the register’s zero as a sentence', () => {
    const html = renderToStaticMarkup(<Discussion depth={0} comments={[]} live />);
    expect(html).toContain('замечаний нет');
    expect(html).toContain('в очереди пусто');
    expect(html).not.toContain('0 замечаний');
  });

  it('prints no edit suffix when there are no edits', () => {
    const html = renderToStaticMarkup(<OwnTrace trace={trace} />);
    expect(html).not.toContain('правок пока нет');
    expect(html).not.toContain('правок: 0');
  });

  it('prints the empty book as a sentence in the colophon', () => {
    const html = renderToStaticMarkup(<Colophon state={state} imprint={front.imprint} />);
    expect(html).toContain('книга · глав ещё нет');
    expect(html).not.toContain('0 глав');
  });
});
