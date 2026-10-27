/**
 * Formatting of the book's numbers and times (DESIGN.md §4.3).
 *
 * Numbers are tabular and separated by a non-breaking space, chapter numbers are
 * zero-padded field numbers, and times are shown in the site's timezone — Moscow — so the
 * ledger reads the same for every reader.
 */

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
