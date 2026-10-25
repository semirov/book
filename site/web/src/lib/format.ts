/**
 * Formatting of the book's numbers and times (DESIGN.md §4.3).
 *
 * Numbers are tabular and separated by a non-breaking space, chapter numbers are
 * zero-padded field numbers, and times are shown in the site's timezone — Moscow — so the
 * ledger reads the same for every reader.
 */

export const SITE_TIMEZONE = 'Europe/Moscow';
export const NBSP = '\u00a0';

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

const shortDateFormatter = new Intl.DateTimeFormat('ru-RU', {
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

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return shortDateFormatter.format(date);
}

export type Chip = { text: string; live: boolean };

/**
 * The header chip says only what the files can prove (DESIGN §8.2, §9): no invented
 * progress, no "online", no fake liveness. Engine-driven states (writing, paused,
 * throttled) arrive with the journal in M3.
 */
export function chipCopy(
  input: { count: number; lastChangeAt: string | null },
  now: Date,
): Chip {
  if (input.count === 0) return { text: 'книга начинается', live: false };
  if (!input.lastChangeAt) return { text: 'записи нет', live: false };

  const changed = new Date(input.lastChangeAt);
  if (Number.isNaN(changed.getTime())) return { text: 'записи нет', live: false };

  const minutes = Math.max(0, Math.floor((now.getTime() - changed.getTime()) / 60_000));
  if (minutes < 1) return { text: 'последняя запись · только что', live: false };
  if (minutes < 60) {
    return {
      text: `последняя запись · ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`,
      live: false,
    };
  }

  const sameDay = dateFormatter.format(changed) === dateFormatter.format(now);
  if (minutes >= 360) {
    return {
      text: sameDay ? `тишина с ${formatTime(input.lastChangeAt)}` : `тишина с ${formatShortDate(input.lastChangeAt)}`,
      live: false,
    };
  }
  return { text: `последняя запись · ${formatTime(input.lastChangeAt)}`, live: false };
}

/** `0` → `замечаний нет`; the queue line of the header and the thread. */
export function queueLabel(depth: number): string {
  if (depth === 0) return 'замечаний нет';
  return `${depth} ${plural(depth, 'замечание', 'замечания', 'замечаний')}`;
}
