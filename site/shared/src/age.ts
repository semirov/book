/**
 * The age gate (BOOK-225): one cookie name, one bound, one reading of the value — shared by the
 * route that writes it (`server/src/http/routes/age.ts`), the route that refuses prose without
 * it (`server/src/http/routes/chapters.ts`) and the page that must not mount the chapter flow
 * before the reader has answered (`web/src/lib/age.ts`).
 *
 * The cookie carries a **day**, not a token: `book_age=YYYY-MM-DD`, written from the site's own
 * clock. A day is what a reader can be shown honestly, the page reads it without the API (so a
 * reload keeps them past the gate), and a day one year back is the whole bound — the same
 * `Max-Age` the cookie states. It is not a credential and it names nobody: the value says when
 * this device answered, and nothing about who answered.
 *
 * The bound is a range, not a flag: a missing value, a value that is not a day, a day that does
 * not exist (`2026-02-30`), a day in the future (the site writes its own clock, so a later day
 * was not written here) and a day older than a year all read as "not answered". Every surface
 * asks this one function, so the page and the refusal can never disagree about who is inside.
 */

/** The cookie the acknowledgement lives in. One name, on both sides of the wire. */
export const AGE_COOKIE = 'book_age';

/** The bound, in seconds: `Max-Age` on the cookie and the whole life of the value, as a year. */
export const AGE_MAX_AGE_SECONDS = 31_536_000;

/**
 * The acknowledgement the site writes: the site's own day, `YYYY-MM-DD`, in UTC — the same
 * clock every stored moment uses (`_at` columns are UTC), so the day on the cookie and the day
 * in the row cannot be a day apart.
 */
export function ageDateOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * A cookie value as the day it names, or `null` when it is not a live acknowledgement.
 *
 * Strict on purpose: the shape is exactly `YYYY-MM-DD`, the day must exist (the round trip
 * through `Date.UTC` refuses `2026-02-30`), the day cannot be ahead of the site's clock, and a
 * day older than `AGE_MAX_AGE_SECONDS` is spent. The value is a day, so the last hours of the
 * bound are approximate by up to 24 h — a reader answers once a year, and the cookie's own
 * `Max-Age` closes the same window.
 */
export function ageDayOf(value: string | undefined, now: Date): string | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(day) || ageDateOf(new Date(day)) !== value) return null;
  const age = now.getTime() - day;
  if (age < 0 || age >= AGE_MAX_AGE_SECONDS * 1_000) return null;
  return value;
}

/**
 * The `book_age` day inside a `Cookie` header — or inside `document.cookie`, which is the same
 * `name=value; name=value` form. One reader, so the page and the server cannot parse the value
 * differently. A malformed percent-escape is a value that is not a day, never a throw: the
 * header is the client's text.
 */
export function ageDayIn(cookieHeader: string | undefined, now: Date): string | null {
  if (cookieHeader === undefined || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() !== AGE_COOKIE) continue;
    const raw = part.slice(index + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      /* not an escape, so not ours: the check below refuses it as a day either way */
    }
    return ageDayOf(value, now);
  }
  return null;
}
