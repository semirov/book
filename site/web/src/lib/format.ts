/**
 * Formatting of the book's numbers and times (DESIGN.md §4.3).
 *
 * Numbers are tabular and separated by a non-breaking space, chapter numbers are
 * zero-padded field numbers, and times are shown in the site's timezone — Moscow — so the
 * ledger reads the same for every reader.
 */

import { queueLine } from '@book/shared';
import type { CommentDto, CommentStatus } from '@book/shared';

export const SITE_TIMEZONE = 'Europe/Moscow';
export const NBSP = '\u00a0';
/** The separator of a date and a time (`25.10.2026 · 12:00`), unbreakable on both sides. */
export const MIDDOT = `${NBSP}·${NBSP}`;

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: SITE_TIMEZONE,
});

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: SITE_TIMEZONE,
});

const dayMonthFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  timeZone: SITE_TIMEZONE,
});

/** `99410` → `99 410` with non-breaking spaces. */
export function formatNumber(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, NBSP);
}

/** Russian plural: `plural(3, 'знак', 'знака', 'знаков')`. */
export function plural(value: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(value));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** `9003` → `9 003 знака`. */
export function formatChars(chars: number): string {
  return `${formatNumber(chars)}${NBSP}${plural(chars, 'знак', 'знака', 'знаков')}`;
}

/** `9003` → `9 003`. */
export function formatCharsShort(chars: number): string {
  return formatNumber(chars);
}

/**
 * BOOK-138 — the download's size, as the link prints it: `1,5 МБ` at a megabyte and above,
 * `512 КБ` below it. A comma is the Russian decimal mark, one decimal place is as much as a
 * reader needs beside a link, and a whole megabyte prints as `1 МБ`, never `1,0 МБ`.
 *
 * The units are decimal (1 КБ = 1 000 bytes, 1 МБ = 1 000 000): КБ/МБ are SI names, and a
 * reader comparing the number with their own file manager, the `content-length` in a log or a
 * release note is comparing it with the same convention. The space before the unit is the plain
 * one, not the site's non-breaking space: this is a measure beside a verb, not a number in a
 * sentence, and the label is allowed to break there.
 *
 * Bytes that are not a positive number print `0 КБ`: the server never reports one, so the value
 * only appears if a payload is broken, and a broken payload must not read as «1,5 МБ».
 */
export function formatFileSize(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const kb = Math.round(safe / 1_000);
  // Below a megabyte the whole number is the unit; rounding up to 1000 КБ would be «1 МБ» and
  // is printed as such by the branch below.
  if (kb < 1_000) return `${kb} КБ`;
  return `${String(Math.round(safe / 100_000) / 10).replace('.', ',')} МБ`;
}

/** `25.10` — the foot's meta line carries the day, never a bare time (owner, 2026-10-28). */
export function formatDayMonth(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dayMonthFormatter.format(date);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return timeFormatter.format(date);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter.format(date);
}

/**
 * `0` → `правок в работе нет`; otherwise the depth with the noun it counts — правки.
 * BOOK-218: the sentence itself lives in `@book/shared`'s `stateWords.ts`.
 */
export function queueLabel(depth: number): string {
  return queueLine(depth);
}

/** A row the register presents as still on its way: a filing, by its public id. */
export type QueueRow = { kind: 'filing'; id: string };

/**
 * The one set the register calls «in the queue».
 *
 * BOOK-137 — a **change is not a row**: it is the attempt of the filing that caused it, shown
 * inside that filing's entry, so counting it beside the filing would count one thing twice.
 * A premise never takes a queue place at all: it waits for the chapter's first pass (BOOK-7),
 * and its row says so in its own word.
 *
 * BOOK-189 — this set decides only which **rows** the register presents as on their way; it
 * never counts the lane. A filing waiting for a decision is not in the writer's queue: the
 * count is the writer's own pending changes (`queueView`), and a page that added the two said
 * «в работе 3 правки» over text that was already written.
 */
const QUEUED_FILING = new Set<CommentStatus>(['new', 'batched', 'delivered', 'accepted']);

/** The entry the register may present as queued: a filing, by public id, with its own state. */
type QueueComment = Pick<CommentDto, 'id' | 'status'> & { premise?: boolean };

/**
 * The queue line and the entries behind it, from one fact.
 *
 * `depth` is the writer's own count of the lane (`queueState().depth`, the `changes` that are
 * `pending` and not a premise) — the same predicate the writer picks its head with. It is the
 * **only** source of the count: a filing is not a queue place, so the rows below are what the
 * page lists, never a second count. When the writer would pick up nothing, the line says
 * «правок в работе нет», whatever the thread still shows as waiting.
 */
export function queueView(
  depth: number,
  entries: readonly QueueComment[] = [],
): { count: number; rows: QueueRow[] } {
  const rows: QueueRow[] = [];
  for (const entry of entries) {
    if (entry.premise === true) continue;
    if (QUEUED_FILING.has(entry.status)) rows.push({ kind: 'filing', id: entry.id });
  }
  return { count: Math.max(0, Math.trunc(depth)), rows };
}
