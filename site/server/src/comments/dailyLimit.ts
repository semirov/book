/**
 * BOOK-DOC-4 rule 5 — the public refusal of an edit and the two day counters' reset.
 *
 * Split out of `comments/service.ts` (BOOK-16, the 500-line arch limit) without changing a
 * word: the day window is answered with one line for both counters, so a refusal never tells
 * a reader which of the two ran out. The message names the moment the next edit becomes
 * possible in the reader's display zone, or omits it when the zone is unusable.
 */

/**
 * BOOK-DOC-4 rule 5, the public refusal: the day window and the moment it resets, in the
 * reader's timezone. It deliberately says neither "identity" nor "address" — the same line
 * answers both counters, so a refusal invites no probing of which one ran out.
 */
export function editDailyMessage(resetAtMs: number | null, tz: string, nowMs: number): string {
  if (resetAtMs === null) return 'правка уже была сегодня — одна правка в сутки';
  const clock = resetClock(resetAtMs, tz, nowMs);
  return clock === null
    ? 'правка уже была сегодня — одна правка в сутки'
    : `правка уже была сегодня — одна правка в сутки; следующая возможна ${clock}`;
}

/**
 * `после 18:00` when the reset is still today, `завтра после 18:00` when it falls on another
 * day in the display zone — the reader is told the truth about the wait, not a bare clock.
 * `null` for an unusable zone (the copy then omits the moment).
 */
function resetClock(atMs: number, tz: string, nowMs: number): string | null {
  try {
    const time = new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).format(new Date(atMs));
    const day = (ms: number): string =>
      new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: tz,
      }).format(new Date(ms));
    return day(atMs) === day(nowMs) ? `после ${time}` : `завтра после ${time}`;
  } catch {
    return null;
  }
}

/** The later of the two edit resets: the next edit needs both counters to have a slot. */
export function laterReset(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
