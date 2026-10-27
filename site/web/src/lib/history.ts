/**
 * The chronicle's pure helpers (ARCHITECTURE §11.10, §6F.2): grouping, filters, the
 * scrubber's scale and the read-only notice a past moment carries.
 *
 * Everything here is a function of the payloads the server sends — no clocks, no fetching —
 * so the chronicle's behaviour is testable without a browser.
 */

import type { BookAtDto, CatalogEntry, HistoryEventDto, HistoryKind } from '@book/shared';

import { formatTime } from './format.ts';

export type HistoryFilter = 'all' | 'changes' | 'drafts' | 'front' | 'overwrites';

export const HISTORY_FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'всё' },
  { id: 'changes', label: 'правки' },
  { id: 'drafts', label: 'черновики' },
  { id: 'front', label: 'первая страница' },
  { id: 'overwrites', label: 'перезаписи' },
];

const KINDS: Record<Exclude<HistoryFilter, 'all'>, HistoryKind[]> = {
  changes: [
    'change.queued',
    'change.processing',
    'change.stale',
    'change.decided',
    'cascade.opened',
    'cascade.closed',
    'step.opened',
    'step.landed',
    'step.closed',
    'gate.recorded',
    'document.status',
    'operator.release',
    'operator.hide',
  ],
  drafts: ['chapter.created', 'chapter.restored', 'operator.restore'],
  front: ['front.revised'],
  overwrites: ['overwrite'],
};

export function filterEvents(items: HistoryEventDto[], filter: HistoryFilter): HistoryEventDto[] {
  if (filter === 'all') return items;
  const kinds = new Set<HistoryKind>(KINDS[filter]);
  return items.filter((event) => kinds.has(event.kind));
}

/** «25 октября» in the site's timezone. */
const DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });

export function dayLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : DAY.format(date);
}

export type DayGroup = { day: string; label: string; items: HistoryEventDto[] };

/** Newest first in, newest first out, one group per calendar day. */
export function groupByDay(items: HistoryEventDto[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const event of items) {
    const day = event.at.slice(0, 10);
    const last = groups.at(-1);
    if (last !== undefined && last.day === day) {
      last.items.push(event);
      continue;
    }
    groups.push({ day, label: dayLabel(event.at), items: [event] });
  }
  return groups;
}

/** «глава 9» · «первая страница» · «книга». */
export function targetLabel(event: HistoryEventDto): string {
  if (event.isFront) return 'первая страница';
  return event.chapter === null ? 'книга' : `глава ${event.chapter}`;
}

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
 * A tick per event on the scrubber's 0..100 scale. The right edge is the book's clock, so
 * an empty log produces no ticks and a single event sits at the right edge.
 */
export function scrubTicks(items: HistoryEventDto[], lastHseq: number): number[] {
  if (lastHseq <= 0) return [];
  return items.map((event) => Math.min(100, Math.max(0, Math.round((event.hseq / lastHseq) * 100))));
}

/** The scrubber's value is an hseq; the label says a moment, or «сейчас». */
export function scrubLabel(value: number, lastHseq: number, at: string | null): string {
  if (lastHseq > 0 && value >= lastHseq) return 'сейчас';
  return at === null ? 'начало книги' : formatTime(at);
}

/** The moment one step to the left/right of a tick list (a scrubber that can be stepped). */
export function stepMoment(items: HistoryEventDto[], value: number, direction: -1 | 1): number {
  const hseqs = items.map((event) => event.hseq).sort((left, right) => left - right);
  if (hseqs.length === 0) return value;
  if (direction === -1) {
    const lower = hseqs.filter((hseq) => hseq < value);
    return lower.length === 0 ? hseqs[0] ?? value : (lower.at(-1) ?? value);
  }
  const higher = hseqs.find((hseq) => hseq > value);
  return higher ?? hseqs.at(-1) ?? value;
}

/** The paragraph chain's copy the server sends; this is the panel's fallback head. */
export function chainHead(chain: { alive: boolean; chapter: number }): string {
  return chain.alive ? `эта строка сейчас в тексте · глава ${chain.chapter}` : `эта строка убрана · глава ${chain.chapter}`;
}
