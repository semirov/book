/**
 * The chronicle's pure helpers (ARCHITECTURE §11.10, §6F.2, BOOK-DOC-50): the moment's dated
 * readout and the read-only notice a past moment carries.
 *
 * Everything here is a function of the payloads the server sends — no clocks, no fetching —
 * so the chronicle's behaviour is testable without a browser. The list is a list of changes
 * (BOOK-65), so these helpers read a `HistoryRecordDto`, not a log row.
 */

import type { BookAtDto, CatalogEntry, HistoryRecordDto, HistoryRecordSpan } from '@book/shared';

import { MIDDOT, NBSP, formatDate, formatTime } from './format.ts';

export type PastDifference = {
  changed: number[];
  front: boolean;
  /** «так книга выглядела в 14:20 · сейчас глава 9 изменена». */
  notice: string;
};

/** What moved between a past moment and now — the honest line at the top of the past. */
export function compareToNow(past: BookAtDto, catalog: CatalogEntry[], frontRev: number): PastDifference {
  const current = new Map(catalog.map((entry) => [entry.n, entry]));
  const changed: number[] = [];
  for (const chapter of past.chapters) {
    const now = current.get(chapter.n);
    if (now === undefined) continue;
    if ((now.rev ?? 0) !== chapter.rev) changed.push(chapter.n);
  }
  const frontChanged = past.front !== null && frontRev > past.front.rev;
  const clock = past.at === null ? 'начало' : formatTime(past.at);
  const tail =
    changed.length === 0
      ? frontChanged
        ? ' · первая страница изменена'
        : ' · с тех пор ничего не изменилось'
      : changed.length === 1
        ? ` · сейчас глава ${changed[0]} изменена`
        : ` · сейчас изменены главы ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` и ещё ${changed.length - 3}` : ''}`;
  return { changed, front: frontChanged, notice: `так книга выглядела в ${clock}${tail}` };
}

/**
 * A moment printed as a date and a time: `25.10.2026 · 12:00` (BOOK-DOC-50 §1). A bare
 * `HH:MM` is what made the old scrubber unreadable, so nothing on the control prints one.
 */
export type MomentParts = {
  /** `25.10.2026` — never broken: a date, a year and a time are each whole (§3). */
  date: string;
  /** ` · 12:00` — the middot carries its own NBSP, so the two parts need no gap. */
  clock: string;
};

/** The one source of the moment's string, split where it may wrap and only there. */
export function momentParts(iso: string | null | undefined): MomentParts {
  return { date: formatDate(iso), clock: `${MIDDOT}${formatTime(iso)}` };
}

export function momentText(iso: string | null | undefined): string {
  const { date, clock } = momentParts(iso);
  return `${date}${clock}`;
}

export type MomentLabel = {
  /** The readout: `25.10.2026 · 12:00`, `до 21.10.2026 · 09:12`, or '' with no records. */
  text: string;
  /** The thumb sits at the right edge, so the label is the book's own last logged moment. */
  isNow: boolean;
  /** The record under the thumb, counted chronologically over the loaded rows: oldest = 1. */
  position: number;
};

/**
 * What the thumb points at, answered from the loaded page alone (BOOK-DOC-50 §2, §6) — the
 * readout is a log fact, never the answer of a request, so it survives a load and a failure.
 *
 * `items` is newest first. At the right edge the readout prints `lastAt` — the **logged** moment
 * of `lastHseq`, not the newest record's: a machine pass moves the book's clock without adding
 * a record, and the old code printed the newest entry's date under «сейчас» (BOOK-65). Before
 * the oldest loaded record the readout says `до …` **only** when an older page exists (`more`);
 * without one it clamps to the oldest record it has and claims nothing it cannot show.
 */
export function momentLabel(
  items: HistoryRecordDto[],
  value: number,
  lastHseq: number,
  more: boolean,
  lastAt: string | null,
): MomentLabel {
  const newest = items[0];
  if (newest === undefined) return { text: '', isNow: false, position: 0 };
  if (lastHseq > 0 && value >= lastHseq) {
    // The fallback is for a log that somehow holds no row at `lastHseq`: never the browser clock.
    return { text: momentText(lastAt ?? newest.at), isNow: true, position: items.length };
  }
  const index = items.findIndex((record) => record.hseq <= value);
  if (index === -1) {
    // Past the oldest loaded record: say «до …» only when the log has an older page.
    const oldest = items[items.length - 1]!;
    return {
      text: more ? `до${NBSP}${momentText(oldest.at)}` : momentText(oldest.at),
      isNow: false,
      position: 1,
    };
  }
  return { text: momentText(items[index]!.at), isNow: false, position: items.length - index };
}

/** The record one step to the left/right of the thumb (a control that can be stepped). */
export function stepMoment(items: HistoryRecordDto[], value: number, direction: -1 | 1): number {
  const hseqs = items.map((record) => record.hseq).sort((left, right) => left - right);
  if (hseqs.length === 0) return value;
  if (direction === -1) {
    const lower = hseqs.filter((hseq) => hseq < value);
    return lower.length === 0 ? hseqs[0] ?? value : (lower.at(-1) ?? value);
  }
  const higher = hseqs.find((hseq) => hseq > value);
  return higher ?? hseqs.at(-1) ?? value;
}

/**
 * `глава 9 · Название` — the one heading of a record entry.
 *
 * The chronicle row and the record behind its door read it from here, so the two cannot call
 * one entry by two different places: the title travels from the server (`chapterTitle`, read
 * from `chapters` when the answer is built), never from a second fetch or a client guess.
 */
export function recordHeading(record: Pick<HistoryRecordDto, 'chapter' | 'chapterTitle'>): string {
  const title = record.chapterTitle?.trim() ?? '';
  return title.length === 0 ? `глава ${record.chapter}` : `глава ${record.chapter} · ${title}`;
}

/**
 * `«было» → «стало»` — one span, one separator, one arrow, typographic quotes.
 *
 * The server only sends a span when the book holds an honest pair, so this function invents
 * nothing; it is the one place the pair becomes copy, so a row cannot grow a second arrow or a
 * doubled quote.
 */
export function spanText(span: HistoryRecordSpan): string {
  return `«${span.before}» → «${span.after}»`;
}

/** The paragraph chain's copy the server sends; this is the panel's fallback head. */export function chainHead(chain: { alive: boolean; chapter: number }): string {
  return chain.alive ? `эта строка сейчас в тексте · глава ${chain.chapter}` : `эта строка убрана · глава ${chain.chapter}`;
}

/**
 * BOOK-68 — the two answers a paragraph's history may speak of, in one place.
 *
 * A 404 is an answer, not a failure: it says «у этой строки нет истории» in the chain panel
 * and in the word's `абзац` row alike. Only a request that never answered says «история не
 * прочиталась» — BOOK-70's one failure line, the same words the chronicle's state line uses —
 * and it offers «повторить» instead of a claim about the text.
 *
 * The wait's own sentence («цепочка читается…») is not here: it belongs to the loading
 * register in `skeleton.ts` (`statusLine('chain', …)`), one sentence for every surface.
 */
export const NO_HISTORY_LINE = 'у этой строки нет истории';
export const CHAIN_FAILED_LINE = 'история не прочиталась';

/** What the panels may say about a paragraph's history while the answer is on its way. */
export type ChainHistory = 'loading' | 'none' | 'ready' | 'failed';
