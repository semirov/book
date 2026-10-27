/**
 * Formatting of the book's numbers and times (DESIGN.md §4.3).
 *
 * Numbers are tabular and separated by a non-breaking space, chapter numbers are
 * zero-padded field numbers, and times are shown in the site's timezone — Moscow — so the
 * ledger reads the same for every reader.
 */

import type { ChangeStatus, ChangeSummaryDto, CommentDto, CommentStatus } from '@book/shared';

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

/** `0` → `в очереди пусто`; otherwise the depth with the noun it counts — правки. */
export function queueLabel(depth: number): string {
  if (depth === 0) return 'в очереди пусто';
  return `в очереди ${depth} ${plural(depth, 'правка', 'правки', 'правок')}`;
}

/** A row the register presents as still on its way: its kind and its public id. */
export type QueueRow = { kind: 'filing' | 'change'; id: string };

/** The two sets the register calls «in the queue» — one place, so the line and the list agree. */
const QUEUED_FILING = new Set<CommentStatus>(['new', 'batched', 'delivered', 'accepted']);
const QUEUED_CHANGE = new Set<ChangeStatus>(['pending', 'processing']);

/** The rows the register may present as queued: a filing and a change, by public id. */
type QueueComment = Pick<CommentDto, 'id' | 'status'>;
type QueueChange = Pick<ChangeSummaryDto, 'id' | 'status' | 'premise'>;

/**
 * The queue line and the list behind it, from one fact.
 *
 * The register shows a filing and a change as one object: a queued row is a filing still in
 * triage (or in the lane) and a non-premise change holding a place (`pending`/`processing`).
 * `depth` is the server's own count of the lane and may include rows beyond this page, so the
 * line prints the larger of the two: it can never say «в очереди пусто» while a row is
 * presented as waiting, and it never shrinks the depth the engine measured.
 */
export function queueView(
  depth: number,
  changes: readonly QueueChange[] = [],
  comments: readonly QueueComment[] = [],
): { count: number; rows: QueueRow[] } {
  const rows: QueueRow[] = [];
  for (const comment of comments) {
    if (QUEUED_FILING.has(comment.status)) rows.push({ kind: 'filing', id: comment.id });
  }
  for (const change of changes) {
    if (change.premise !== true && QUEUED_CHANGE.has(change.status)) rows.push({ kind: 'change', id: change.id });
  }
  return { count: Math.max(Math.max(0, Math.trunc(depth)), rows.length), rows };
}
